import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import {
  createConfigLifecycle,
  flushPendingSessionConfigWrites,
  resolveInitialConfigState,
} from './config-lifecycle.mjs';
import { createNewSessionConfig } from './new-session-config.mjs';
import { createSessionLifecycle } from './session-lifecycle.mjs';
import { makeResolveRoute } from './config-helpers.mjs';

const resolveRoute = makeResolveRoute(() => 'test-provider');
function configFor(model) {
  return {
    builtins: {},
    providers: { 'test-provider': { enabled: true } },
    presets: [{ id: 'lead', provider: 'test-provider', model }],
    default: 'lead',
    workflow: { active: 'solo' },
    compaction: { auto: true },
    autoClear: { enabled: true },
    modules: { memory: { enabled: true } },
    skills: { disabled: [] },
    mcpServers: {},
  };
}

function fixture() {
  const root = { agent: configFor('before'), outputStyle: 'simple', memory: { embedding: { dtype: 'q8' } } };
  const calls = [];
  const sharedCfgMod = {
    pendingConfigWrites: async () => {},
    invalidateConfigReadCache() {
      calls.push('invalidate-disk');
    },
    readSection: (name) => root[name],
    updateConfigAsync: async (update) => Object.assign(root, update(root)),
  };
  const cfgMod = {
    loadConfig: () => structuredClone(root.agent),
    saveConfig: (next) => {
      root.agent = structuredClone(next);
    },
    saveConfigAsync: async (next) => {
      root.agent = structuredClone(next);
    },
    patchSkillsDisabled: (names) => {
      root.agent.skills = { disabled: [...names] };
    },
    patchSkillsDisabledAsync: async (names) => {
      root.agent.skills = { disabled: [...names] };
    },
    getPluginData: () => process.cwd(),
  };
  function runtime(options = {}) {
    const rt = {
      ...resolveInitialConfigState({ loadConfig: cfgMod.loadConfig, resolveRoute, ...options }),
      mode: 'full',
      currentCwd: process.cwd(),
      mcpScopeId: 'test-scope',
      session: null,
    };
    let hasSecrets = true;
    const lifecycle = createConfigLifecycle({
      getConfig: () => rt.config,
      setConfig: (next) => {
        rt.config = next;
      },
      getConfigHasSecrets: () => hasSecrets,
      setConfigHasSecrets: (next) => {
        hasSecrets = next;
      },
      getWebSearchRoute: () => rt.webSearchRoute,
      setWebSearchRoute: (next) => {
        rt.webSearchRoute = next;
      },
      getRoute: () => rt.route,
      cfgMod,
      sharedCfgMod,
      setConfiguredShell() {},
      normalizeSystemShellConfig: (value) => ({ command: value?.command || '' }),
      normalizeWebSearchRouteConfig: (value) => value || null,
      LAZY_SECRET_PROVIDERS: new Set(),
      clean: (value) => String(value || '').trim(),
      resolve,
      STANDALONE_DATA_DIR: process.cwd(),
    });
    const prepare = createNewSessionConfig({
      rt,
      sharedCfgMod,
      reloadFullConfig: lifecycle.reloadFullConfig,
      resolveRoute,
      initialConfig: options.initialConfig,
      initialRouteExplicit: options.provider !== undefined || options.model !== undefined,
      invalidatePreSessionToolSurface() {
        calls.push('invalidate-tools');
      },
      invalidateOutputStyleStatusCache() {
        calls.push('invalidate-style');
      },
      invalidateSkills() {
        calls.push('invalidate-skills');
      },
      connectConfiguredMcp: async () => {
        calls.push(['mcp', structuredClone(rt.config.mcpServers)]);
      },
      configureEmbedding: async (config) => {
        calls.push(['embedding', structuredClone(config)]);
      },
    });
    return { rt, lifecycle, prepare };
  }
  return { root, calls, cfgMod, sharedCfgMod, runtime };
}

test('a new runtime immediately observes pending settings from another runtime', async () => {
  const f = fixture();
  const writer = f.runtime();
  const untouched = f.runtime();
  const before = structuredClone(untouched.rt.config);
  const latest = {
    ...configFor('after'),
    profile: { title: 'NEW PROFILE', language: 'ko', experienceLevel: 'advanced' },
    workflow: { active: 'updated-workflow' },
    compaction: { auto: false, mainBufferTokens: 12000 },
    autoClear: { enabled: false },
    modules: { memory: { enabled: false }, webSearch: { enabled: false }, office: { enabled: false } },
    shell: { command: 'custom-shell' },
    webSearchRoute: { provider: 'test-provider', model: 'search-after' },
    mcpServers: { demo: { command: 'new-server', enabled: false } },
  };
  writer.lifecycle.saveConfigAndAdopt(latest);
  writer.lifecycle.scheduleSkillsSave(['disabled-skill']);
  writer.lifecycle.scheduleOutputStyleSave('detailed');

  await flushPendingSessionConfigWrites();
  const fresh = f.runtime();
  await fresh.prepare();
  assert.deepEqual(fresh.rt.config, { ...latest, skills: { disabled: ['disabled-skill'] } });
  assert.equal(fresh.rt.route.model, 'after');
  assert.equal(f.root.outputStyle, 'detailed');
  assert.deepEqual(fresh.rt.webSearchRoute, latest.webSearchRoute);
  assert.deepEqual(untouched.rt.config, before);
  assert.equal(untouched.rt.route.model, 'before');
});

test('a reused runtime reloads all settings and its default route without modifying peer sessions', async () => {
  const f = fixture();
  const reused = f.runtime();
  await reused.prepare();
  const peer = f.runtime();
  peer.rt.session = { id: 'existing', messages: [{ role: 'user', content: 'keep this' }] };
  const originalPeer = structuredClone(peer.rt);
  const writer = f.runtime();
  writer.lifecycle.saveConfigAndAdopt({
    ...configFor('replacement'),
    profile: { language: 'ja' },
    compaction: { auto: false },
    modules: { memory: { enabled: false } },
    mcpServers: { demo: { command: 'replacement-server' } },
  });
  f.root.memory.embedding.dtype = 'fp16';
  await reused.prepare();
  assert.deepEqual(reused.rt.config, f.root.agent);
  assert.equal(reused.rt.route.model, 'replacement');
  assert.ok(
    f.calls.some((call) => Array.isArray(call) && call[0] === 'mcp' && call[1].demo.command === 'replacement-server')
  );
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'embedding' && call[1].dtype === 'fp16'));
  assert.deepEqual(peer.rt, originalPeer);
});

test('an explicit first route survives reload; the next fresh session uses the latest default', async () => {
  const f = fixture();
  const runtime = f.runtime({ provider: 'explicit-provider', model: 'explicit-model' });
  f.root.agent = configFor('latest');
  await runtime.prepare();
  assert.equal(runtime.rt.route.provider, 'explicit-provider');
  assert.equal(runtime.rt.route.model, 'explicit-model');
  await runtime.prepare();
  assert.equal(runtime.rt.route.model, 'latest');
});

test('an injected headless policy is not replaced by interactive settings', async () => {
  const f = fixture();
  const initialConfig = { ...configFor('isolated'), workflow: { active: 'headless' } };
  const runtime = f.runtime({ initialConfig });
  f.root.agent = configFor('interactive');
  await runtime.prepare();
  await runtime.prepare();
  assert.deepEqual(runtime.rt.config, initialConfig);
  assert.equal(runtime.rt.route.model, 'isolated');
});

test('new-session preparation waits for a write in flight and the latest coalesced settings', async () => {
  const f = fixture();
  const writer = f.runtime();
  const next = f.runtime();
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const save = f.cfgMod.saveConfigAsync;
  f.cfgMod.saveConfigAsync = async (snapshot) => {
    await gate;
    await save(snapshot);
  };
  writer.lifecycle.saveConfigAndAdopt(configFor('first-change'));
  let prepared = false;
  const pending = next.prepare().then(() => {
    prepared = true;
  });
  await setImmediate();
  assert.equal(prepared, false);
  writer.lifecycle.saveConfigAndAdopt(configFor('last-change'));
  finish();
  await pending;
  assert.equal(next.rt.route.model, 'last-change');
});

for (const channel of ['config', 'skills', 'outputStyle']) {
  test(`failed ${channel} persistence blocks new-session creation without discarding the change`, async () => {
    const f = fixture();
    const writer = f.runtime();
    const next = f.runtime();
    const module = channel === 'outputStyle' ? f.sharedCfgMod : f.cfgMod;
    const method = { config: 'saveConfigAsync', skills: 'patchSkillsDisabledAsync', outputStyle: 'updateConfigAsync' }[
      channel
    ];
    const save = module[method];
    module[method] = async () => {
      throw new Error('fixture persistence failure');
    };
    if (channel === 'config') writer.lifecycle.saveConfigAndAdopt(configFor('saved-later'));
    if (channel === 'skills') writer.lifecycle.scheduleSkillsSave(['saved-later']);
    if (channel === 'outputStyle') writer.lifecycle.scheduleOutputStyleSave('saved-later');
    try {
      await assert.rejects(next.prepare(), /pending settings could not be saved/);
      assert.equal(next.rt.route.model, 'before');
      assert.equal(f.calls.includes('invalidate-tools'), false);
    } finally {
      module[method] = save;
      await flushPendingSessionConfigWrites();
    }
    await next.prepare();
    if (channel === 'config') assert.equal(next.rt.route.model, 'saved-later');
    if (channel === 'skills') assert.deepEqual(next.rt.config.skills.disabled, ['saved-later']);
    if (channel === 'outputStyle') assert.equal(f.root.outputStyle, 'saved-later');
  });
}

test('the creation boundary refreshes before memory/tools/workflow, but skips an existing conversation', async () => {
  const f = fixture();
  const current = f.runtime();
  const writer = f.runtime();
  let creations = 0;
  const api = createSessionLifecycle({
    rt: current.rt,
    prepareNewSessionConfig: current.prepare,
    awaitKeychainPrewarm: async () => {},
    ensureConfigForRouteProvider() {},
    ensureProvidersReady: async () => {},
    lookupModelMeta: async (provider, model) => ({ provider, id: model }),
    loadCoreMemoryContext: async () => (current.rt.config.modules.memory.enabled ? 'old memory' : ''),
    mgr: {
      getSession: () => current.rt.session,
      createSession: (options) => ({ ...options, id: `test-${++creations}`, messages: [], tools: [] }),
    },
    adoptSession: (session) => {
      current.rt.session = session;
    },
    reg: { getProvider: () => ({}) },
    cfgMod: f.cfgMod,
    activeWorkflowContext: (config) => ({ summary: config.workflow, context: config.workflow.active }),
    hooks: { emit() {}, dispatch: async () => ({}) },
    hookCommonPayload: (value) => value,
    mcpClient: { getMcpTools: () => [] },
    modelStandaloneTools: () => [],
    featureDisallowedTools: () => (current.rt.config.modules.memory.enabled ? [] : ['memory', 'recall']),
    applyPreSessionToolSelection() {},
    statusRoutes: {},
    warmupTimers: {},
    providerModelCaches: {},
    prewarmTimers: {},
    prewarmState: {},
  });
  writer.lifecycle.saveConfigAndAdopt({
    ...configFor('after'),
    modules: { memory: { enabled: false } },
    workflow: { active: 'new-workflow' },
    compaction: { auto: false },
  });
  const created = await api.createCurrentSession();
  assert.equal(created.model, 'after');
  assert.equal(created.coreMemoryContext, '');
  assert.equal(created.workflowContext, 'new-workflow');
  assert.equal(created.compaction.auto, false);
  assert.deepEqual(
    created.disallowedTools.filter((name) => ['memory', 'recall'].includes(name)),
    ['memory', 'recall']
  );
  created.messages.push({ role: 'user', content: 'keep this conversation' });
  const frozen = structuredClone(created);
  writer.lifecycle.saveConfigAndAdopt(configFor('next-only'));
  assert.equal(await api.createCurrentSession(), created);
  assert.deepEqual(created, frozen);
  assert.equal(creations, 1);
  current.rt.session = null;
  const next = await api.createCurrentSession();
  assert.equal(next.model, 'next-only');
  assert.equal(next.coreMemoryContext, 'old memory');
  assert.equal(creations, 2);
});
