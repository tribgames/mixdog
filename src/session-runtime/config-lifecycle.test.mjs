import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { createConfigLifecycle, resolveInitialConfigState } from './config-lifecycle.mjs';
import { createConfigChangeEffects } from './config-change-effects.mjs';
import { applyConfigPatch, diffConfig } from '../runtime/shared/config-patch.mjs';
import { withStoredDisabledAgents } from '../runtime/shared/agent-route-config.mjs';
import {
  DEFAULT_MAINTENANCE,
  maintenanceDelta,
  presetsDelta,
  withDefaultPresets,
} from '../runtime/agent/orchestrator/config-presets.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture({
  config = {},
  disk,
  mainRoute,
  session = null,
  injectedConfig = false,
  outputStyleStatus = () => ({}),
  sharedCfg = {},
  onConfigChanged,
  effectRetryDelaysMs,
} = {}) {
  // mainRoute set: the lifecycle may sync the runtime Main route on reload.
  let route = mainRoute || { provider: 'demo' };
  let current = {
    builtins: {},
    providers: { demo: { enabled: true } },
    skills: { disabled: [] },
    theme: 'old',
    ...config,
  };
  let root = { agent: structuredClone(disk ?? current), outputStyle: 'simple' };
  let hasSecrets = false;
  let webSearchRoute = null;
  const writes = [];
  const cfgMod = {
    loadConfig: () => structuredClone(root.agent),
    createConfigPatch: diffConfig,
    saveConfigPatch: (changes) => {
      writes.push('config:sync');
      root.agent = applyConfigPatch(root.agent, changes);
    },
    saveConfigPatchAsync: async (changes) => {
      writes.push('config');
      root.agent = applyConfigPatch(root.agent, changes);
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
    readConfig: () => structuredClone(root),
    ...sharedCfg,
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
    getRoute: () => route,
    getSession: () => session,
    injectedConfig,
    onConfigChanged,
    effectRetryDelaysMs,
    ...(mainRoute
      ? {
          setRouteState: (next) => {
            route = next;
          },
          resolveRoute: (cfg) => ({ provider: 'demo', model: cfg.leadModel || '' }),
        }
      : {}),
    cfgMod,
    sharedCfgMod,
    setConfiguredShell() {},
    normalizeSystemShellConfig: () => ({ command: '' }),
    normalizeWebSearchRouteConfig: (value) => value || null,
    outputStyleStatus,
    LAZY_SECRET_PROVIDERS: new Set(),
    clean: (value) => String(value || '').trim(),
    resolve,
    STANDALONE_DATA_DIR: process.cwd(),
  });
  return { lifecycle, cfgMod, sharedCfgMod, writes, config: () => current, disk: () => root, route: () => route };
}

test('a reload that brings in a Lead route fills an empty Main route and never replaces a chosen one', () => {
  // The Lead route was edited on disk (or by another process) while this
  // runtime had no model: a pending backfill must now find it set.
  const empty = fixture({ mainRoute: { provider: 'demo', model: '' } });
  empty.disk().agent.leadModel = 'model-ext';
  empty.lifecycle.reloadFullConfig();
  assert.equal(empty.route().model, 'model-ext');
  // A route that already has a model is the selection of this runtime.
  const chosen = fixture({ mainRoute: { provider: 'demo', model: 'picked' } });
  chosen.disk().agent.leadModel = 'model-ext';
  chosen.lifecycle.reloadFullConfig();
  assert.equal(chosen.route().model, 'picked');
  // A reload that brings no Lead route leaves the route empty.
  const none = fixture({ mainRoute: { provider: 'demo', model: '' } });
  none.lifecycle.reloadFullConfig();
  assert.equal(none.route().model, '');
});

// Issue #237: a shared-config reload reaches the live session's compaction.
test('a reload updates the live session compaction, keeping its own fields', () => {
  const session = { id: 's1', compaction: { auto: false, mainBufferTokens: 8000, conversationThresholdTokens: 5 } };
  const f = fixture({ session, disk: { compaction: { auto: true, mainBufferPercent: 20 } } });
  f.lifecycle.reloadFullConfig();
  assert.equal(session.compaction.auto, true);
  assert.equal(session.compaction.mainBufferPercent, 20);
  assert.equal(Object.hasOwn(session.compaction, 'mainBufferTokens'), false);
  assert.equal(session.compaction.conversationThresholdTokens, 5);
  // A disk config without a compaction section leaves the session alone.
  const bare = { id: 's2', compaction: { auto: false } };
  fixture({ session: bare, disk: { theme: 'x' } }).lifecycle.reloadFullConfig();
  assert.deepEqual(bare.compaction, { auto: false });
});

test('removing a configured compaction value reverts the live session to the default', () => {
  const session = {
    id: 's1',
    compaction: {
      summaryModel: 'old-model',
      memoryTimeoutMs: 1234,
      model: 'm',
      timeoutMs: 9,
      bufferTokens: 7,
      archive: { nextSeq: 2 },
    },
  };
  fixture({ session, disk: { compaction: { auto: true } } }).lifecycle.reloadFullConfig();
  for (const key of ['summaryModel', 'memoryTimeoutMs', 'model', 'timeoutMs', 'bufferTokens']) {
    assert.equal(Object.hasOwn(session.compaction, key), false, key);
  }
  assert.deepEqual(session.compaction.archive, { nextSeq: 2 });
  assert.equal(session.compaction.summaryMode, 'smart');
});

test('an injected (headless) config never follows the disk: no subscription, no reload, fixed compaction', () => {
  const session = { id: 's1', compaction: { auto: false, mainBufferTokens: 8000 } };
  let subscriptions = 0;
  const injected = { workflow: { active: 'headless' }, orchestrationMode: 'none' };
  const f = fixture({
    config: injected,
    session,
    injectedConfig: true,
    disk: { workflow: { active: 'default' }, orchestrationMode: 'balanced', compaction: { auto: true } },
    sharedCfg: {
      subscribeConfigChange: () => {
        subscriptions += 1;
        return () => {};
      },
    },
  });
  assert.equal(subscriptions, 0);
  f.lifecycle.ensureFullConfig();
  f.lifecycle.reloadFullConfig();
  assert.equal(f.config().workflow.active, 'headless');
  assert.equal(f.config().orchestrationMode, 'none');
  assert.deepEqual(session.compaction, { auto: false, mainBufferTokens: 8000 });
});

test('an output style chosen during the save debounce survives a concurrent write and its reload', async () => {
  const styles = [
    { id: 'simple', label: 'Simple' },
    { id: 'detailed', label: 'Detailed' },
  ];
  const f = fixture({
    outputStyleStatus: () => ({ configured: f.disk().outputStyle, current: styles[0], styles }),
  });
  f.lifecycle.adoptConfig({ ...f.config(), outputStyle: 'detailed' });
  f.lifecycle.scheduleOutputStyleSave('detailed');
  // Another runtime's write lands inside the debounce window.
  f.disk().agent.theme = 'peer';
  f.lifecycle.reloadFullConfig();
  assert.equal(f.config().outputStyle, 'detailed');
  assert.equal(f.config().theme, 'peer');
  const status = f.lifecycle.getOutputStyleStatusCached({ fresh: true });
  assert.equal(status.configured, 'detailed');
  assert.equal(status.current.id, 'detailed');
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.equal(f.disk().outputStyle, 'detailed');
  assert.equal(f.lifecycle.getOutputStyleStatusCached({ fresh: true }).configured, 'detailed');
});

test('the change step runs effects keyed by what changed, once per change, the writer included', () => {
  let tokens = {};
  let notify = null;
  const changes = [];
  // The buckets this test exercises (config-change-effects.test.mjs covers the rest).
  const pick = ({ providers, mcp, settings }) => ({ providers, mcp, settings });
  const f = fixture({
    // The boot config is loaded without secrets or credential probes; the
    // stored config behind it is the same.
    config: { providers: { demo: { enabled: false, credentialProbeUnavailable: true } }, mcpServers: {} },
    disk: { providers: { demo: { enabled: true } }, mcpServers: {} },
    sharedCfg: {
      secretChangeTokens: () => ({ ...tokens }),
      subscribeConfigChange: (listener) => {
        notify = listener;
        return () => {};
      },
    },
    onConfigChanged: (change) => changes.push(change),
  });
  // The first notification after boot (a rewrite of identical content) is no
  // change, although this full load reads secrets the boot load did not.
  notify();
  assert.deepEqual(pick(changes.pop()), { providers: false, mcp: false, settings: false });
  // A key replaced in the keychain (any process): only its change token moves.
  tokens = { 'agent.demo.apiKey': 't1' };
  f.disk().agent.providers.demo.apiKey = 'new-key';
  // The writer applies the change itself; its own notification then finds nothing.
  assert.deepEqual(pick(f.lifecycle.applyConfigChange()), { providers: true, mcp: false, settings: true });
  assert.equal(f.config().providers.demo.apiKey, 'new-key');
  notify();
  assert.deepEqual(pick(changes.pop()), { providers: false, mcp: false, settings: false });
  // A non-provider secret is a settings change only.
  tokens = { ...tokens, 'agent.openai.usageSessionKey': 't2' };
  notify();
  assert.deepEqual(pick(changes.pop()), { providers: false, mcp: false, settings: true });
  // A hand edit of an MCP server reaches the reconcile.
  f.disk().agent.mcpServers = { docs: { command: 'docs-server' } };
  notify();
  assert.deepEqual(pick(changes.pop()), { providers: false, mcp: true, settings: true });
});

test('a notification that changes nothing keeps the config object; a real change replaces it', () => {
  let tokens = { 'agent.demo.apiKey': 't1' };
  let notify = null;
  const passed = [];
  const f = fixture({
    sharedCfg: {
      secretChangeTokens: () => ({ ...tokens }),
      subscribeConfigChange: (listener) => {
        notify = listener;
        return () => {};
      },
    },
    onConfigChanged: (_change, config) => passed.push(config),
  });
  // A marker rewritten with identical content, then again: the same object
  // throughout, so consumers keyed on it skip their reconcile.
  const before = f.config();
  notify();
  notify();
  assert.equal(f.config(), before);
  assert.deepEqual(passed, [before, before]);
  // A secret changed elsewhere, then a setting: each replaces it.
  tokens = { 'agent.demo.apiKey': 't2' };
  notify();
  const afterSecret = f.config();
  assert.notEqual(afterSecret, before);
  f.disk().agent.theme = 'peer';
  notify();
  assert.notEqual(f.config(), afterSecret);
  assert.equal(f.config().theme, 'peer');
});

test('an effect that failed is applied again by the next step and by the retry, never left stale', async () => {
  let notify = null;
  const steps = [];
  let fail = null;
  const f = fixture({
    disk: { mcpServers: {} },
    config: { mcpServers: {} },
    effectRetryDelaysMs: [20],
    sharedCfg: {
      subscribeConfigChange: (listener) => {
        notify = listener;
        return () => {};
      },
    },
    onConfigChanged: (change) => {
      steps.push(change.mcp);
      if (!change.mcp || !fail) return Promise.resolve([]);
      const outcome = fail;
      fail = null;
      return outcome;
    },
  });
  // The reconcile is still in flight when an identical notification arrives:
  // that step does not repeat it; once it fails, the next step runs it again.
  let rejectReconcile;
  fail = new Promise((resolve) => {
    rejectReconcile = () => resolve(['mcp']);
  });
  f.disk().agent.mcpServers = { docs: { command: 'docs-server' } };
  notify();
  notify();
  rejectReconcile();
  await setImmediate();
  notify();
  assert.deepEqual(steps, [true, false, true]);
  // Failing again with no notification to follow: the retry applies it.
  steps.length = 0;
  fail = Promise.resolve(['mcp']);
  f.disk().agent.mcpServers = { docs: { command: 'docs-server-2' } };
  f.lifecycle.applyConfigChange();
  await setTimeout(80);
  assert.deepEqual(steps, [true, true]);
  // Applied, it is no change any more; the config object then stays put.
  const applied = f.config();
  notify();
  assert.deepEqual(steps, [true, true, false]);
  assert.equal(f.config(), applied);
  f.lifecycle.disposeConfigSync();
});

test('a failing effect is retried past the listed delays, at the last one, until it succeeds', async () => {
  let failuresLeft = 5;
  let attempts = 0;
  const f = fixture({
    disk: { mcpServers: { docs: { command: 'docs-server' } } },
    config: { mcpServers: {} },
    effectRetryDelaysMs: [5, 10],
    onConfigChanged: (change) => {
      if (!change.mcp) return Promise.resolve([]);
      attempts += 1;
      return Promise.resolve(failuresLeft-- > 0 ? ['mcp'] : []);
    },
  });
  f.lifecycle.applyConfigChange();
  for (let waited = 0; attempts < 6 && waited < 2000; waited += 10) await setTimeout(10);
  assert.equal(attempts, 6, 'five failures, then the success');
  await setTimeout(50);
  assert.equal(attempts, 6, 'nothing retried once it succeeded');
  f.lifecycle.disposeConfigSync();
});

test('an offline MCP server is retried without replacing the config object or repeating its warning', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (line) => warnings.push(line);
  let offline = true;
  const reconciledWith = [];
  const f = fixture({
    disk: { mcpServers: { docs: { command: 'docs-server' } } },
    config: { mcpServers: {} },
    effectRetryDelaysMs: [5],
    onConfigChanged: createConfigChangeEffects({
      invalidateContextStatusCache() {},
      reinitProviders() {},
      releaseAdmissionCooldowns() {},
      announceSettingsChange() {},
      reconcileMcp: () => {
        reconciledWith.push(f.config());
        if (offline) throw new Error('docs: connect ECONNREFUSED');
      },
    }),
  });
  try {
    f.lifecycle.applyConfigChange();
    const adopted = f.config();
    for (let waited = 0; reconciledWith.length < 5 && waited < 2000; waited += 10) await setTimeout(10);
    assert.ok(reconciledWith.length >= 5, 'retried');
    assert.equal(f.config(), adopted, 'the retries keep the config object');
    assert.ok(reconciledWith.every((config) => config === adopted));
    assert.equal(warnings.length, 1, 'one warning for the same failure');
    offline = false;
    const count = reconciledWith.length;
    for (let waited = 0; reconciledWith.length === count && waited < 2000; waited += 10) await setTimeout(10);
    await setTimeout(30);
    const settled = reconciledWith.length;
    await setTimeout(30);
    assert.equal(reconciledWith.length, settled, 'recovered: no more retries');
    // A real settings change still replaces it.
    f.disk().agent.theme = 'peer';
    f.lifecycle.applyConfigChange();
    assert.notEqual(f.config(), adopted);
  } finally {
    console.warn = realWarn;
    f.lifecycle.disposeConfigSync();
  }
});

test('the first save seeds fresh-profile defaults no diff carries, never over stored values', async () => {
  // A brand-new profile: defaults in memory, nothing of them on disk yet.
  const f = fixture({ config: { disabledAgents: ['maintainer', 'worker'] }, disk: { theme: 'old' } });
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'next' });
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.disk().agent.builtins, {});
  // Off-by-default agents live in code and are never seeded into the file.
  assert.equal(Object.hasOwn(f.disk().agent, 'disabledAgents'), false);
  // Once stored, the user's own value wins over every later seed.
  f.disk().agent.builtins = { git: { installed: true } };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'again' });
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.disk().agent.builtins, { git: { installed: true } });
  assert.equal(f.disk().agent.theme, 'again');
});

test('synchronous reload cannot overtake an older asynchronous config write', async () => {
  const f = fixture();
  const gate = deferred();
  const save = f.cfgMod.saveConfigPatchAsync;
  let calls = 0;
  f.cfgMod.saveConfigPatchAsync = async (snapshot) => {
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
  f.cfgMod.saveConfigPatch = () => {
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

test('automatic skills debounce drains older config edits first', async () => {
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
  // Auto effort follows the same rule: only an explicit boolean overrides.
  assert.equal(Object.hasOwn(untouched.route, 'autoEffort'), false);
  assert.equal(initialState({ autoEffort: false }).route.autoEffort, false);
  assert.equal(initialState({ autoEffort: true }).route.autoEffort, true);
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

test('a failed config write cannot consume the pending skills patch', async () => {
  const f = fixture();
  const save = f.cfgMod.saveConfigPatchAsync;
  f.cfgMod.saveConfigPatchAsync = async () => {
    throw new Error('fixture write failed');
  };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'latest' });
  f.lifecycle.scheduleSkillsSave(['demo']);
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.writes, []);
  f.cfgMod.saveConfigPatchAsync = save;
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.writes, ['config', 'skills']);
  assert.equal(f.disk().agent.theme, 'latest');
  assert.deepEqual(f.disk().agent.skills.disabled, ['demo']);
});

test('an unchanged save does not write or undo a peer setting', async () => {
  const f = fixture();
  f.disk().agent.theme = 'peer';
  f.lifecycle.saveConfigAndAdopt(structuredClone(f.config()));
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.writes, []);
  assert.equal(f.disk().agent.theme, 'peer');
});

test('a pending reload overlays only local edits and preserves fresh peer settings', async () => {
  const f = fixture();
  const save = f.cfgMod.saveConfigPatch;
  f.cfgMod.saveConfigPatch = () => {
    throw new Error('fixture lock busy');
  };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'local' });
  f.disk().agent.profile = { language: 'en' };
  assert.equal(f.lifecycle.reloadFullConfig().profile.language, 'en');
  assert.equal(f.config().theme, 'local');
  f.cfgMod.saveConfigPatch = save;
  await f.lifecycle.flushAllConfigSavesAsync();
  f.disk().agent.profile.language = 'ja';
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'later' });
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.equal(f.disk().agent.profile.language, 'ja');
  assert.equal(f.disk().agent.theme, 'later');
});

test('a reload during a blocked save keeps the shipped presets and maintenance routes', async () => {
  const custom = { id: 'mine', name: 'MINE', type: 'agent', provider: 'openai', model: 'gpt-x', tools: 'full' };
  const extra = { ...custom, id: 'extra', name: 'EXTRA' };
  const stored = (config) => {
    const next = {
      ...config,
      presets: presetsDelta(config.presets),
      maintenance: maintenanceDelta(config.maintenance),
    };
    for (const key of ['presets', 'maintenance']) if (!Object.keys(next[key]).length) delete next[key];
    return next;
  };
  const f = fixture({
    config: { presets: withDefaultPresets([custom]), maintenance: { ...DEFAULT_MAINTENANCE } },
    disk: stored({ presets: withDefaultPresets([custom]), maintenance: { ...DEFAULT_MAINTENANCE } }),
  });
  f.cfgMod.loadConfig = () => {
    const disk = structuredClone(f.disk().agent);
    return {
      ...disk,
      presets: withDefaultPresets(disk.presets),
      maintenance: { ...DEFAULT_MAINTENANCE, ...disk.maintenance },
    };
  };
  f.cfgMod.createConfigPatch = (before, after) => diffConfig(stored(before), stored(after));
  f.cfgMod.saveConfigPatch = () => {
    throw new Error('fixture lock busy');
  };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), presets: [...f.config().presets, extra] });
  const loaded = f.lifecycle.reloadFullConfig();
  assert.deepEqual(loaded.presets.map((p) => p.id).sort(), [
    'extra',
    'haiku',
    'mine',
    'opus-high',
    'opus-mid',
    'sonnet-high',
    'sonnet-mid',
  ]);
  assert.deepEqual(loaded.maintenance, DEFAULT_MAINTENANCE);
});

test('a reload during a blocked save keeps an enabled agent when patches speak the delta domain', async () => {
  const f = fixture({ config: { disabledAgents: ['worker'] }, disk: { disabledAgents: ['worker'] } });
  f.cfgMod.createConfigPatch = (before, after) =>
    diffConfig(withStoredDisabledAgents(before), withStoredDisabledAgents(after));
  f.cfgMod.saveConfigPatch = () => {
    throw new Error('fixture lock busy');
  };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), disabledAgents: [] });
  const loaded = f.lifecycle.reloadFullConfig();
  assert.equal(loaded.disabledAgents?.includes('worker') ?? false, false);
});

test('an in-flight success is not replayed over a newer peer change by the next local write', async () => {
  const f = fixture();
  const gate = deferred();
  const started = deferred();
  const save = f.cfgMod.saveConfigPatchAsync;
  let writes = 0;
  f.cfgMod.saveConfigPatchAsync = async (changes) => {
    await save(changes);
    if (++writes === 1) {
      started.resolve();
      await gate.promise;
    }
  };
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'first-local' });
  const flushed = f.lifecycle.flushAllConfigSavesAsync();
  await started.promise;
  f.disk().agent.theme = 'newer-peer';
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), profile: { title: 'second-local' } });
  gate.resolve();
  await flushed;
  assert.equal(f.disk().agent.theme, 'newer-peer');
  assert.equal(f.disk().agent.profile.title, 'second-local');
});

test('a debounce burst keeps the last explicit edit even when it returns to the starting value', async () => {
  const f = fixture();
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'temporary' });
  f.disk().agent.theme = 'peer';
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'old' });
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.equal(f.disk().agent.theme, 'old');
  assert.deepEqual(f.writes, ['config']);
});

test('model settings adopted before the route save are persisted without unrelated stale fields', async () => {
  const f = fixture();
  f.disk().agent.profile = { language: 'en' };
  f.lifecycle.adoptConfig({ ...f.config(), modelSettings: { 'demo/model': { effort: 'high', fast: true } } });
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), default: 'lead' });
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.disk().agent.modelSettings, { 'demo/model': { effort: 'high', fast: true } });
  assert.equal(f.disk().agent.default, 'lead');
  assert.equal(f.disk().agent.profile.language, 'en');
});

test('an unrelated save does not replay a completed skills toggle', async () => {
  const f = fixture();
  f.lifecycle.adoptConfig({ ...f.config(), skills: { disabled: ['local'] } });
  f.lifecycle.scheduleSkillsSave(['local']);
  await f.lifecycle.flushSkillsSave();
  f.disk().agent.skills.disabled = ['peer'];
  f.lifecycle.saveConfigAndAdopt({ ...f.config(), theme: 'local' });
  await f.lifecycle.flushAllConfigSavesAsync();
  assert.deepEqual(f.disk().agent.skills.disabled, ['peer']);
});
