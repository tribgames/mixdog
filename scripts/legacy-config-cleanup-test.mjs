import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('agent config migrates legacy Fast preferences and stops persisting dead containers', async () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-legacy-config-'));
  const configPath = join(dataDir, 'mixdog-config.json');
  writeFileSync(configPath, JSON.stringify({
    autoClear: { enabled: false, thresholdMs: 12345, custom: true, providerDefaults: {} },
    compaction: { enabled: false, compactType: 'summary' },
    shell: { path: 'pwsh', timeoutMs: 9876 },
    search: { requestTimeoutMs: 999 },
    capabilities: { homeAccess: true },
    memory: {
      enabled: false,
      user: { title: 'Preserved title', locale: 'ko' },
      cycle1: { interval: '7m' },
      embedding: { model: 'keep-me' },
    },
    channels: {
      provider: 'discord',
      promptInjection: { mode: 'hook' },
      schedules: { items: [{ name: 'retired' }] },
      nonInteractive: [{ name: 'retired' }],
      interactive: [{ name: 'retired' }],
      channel: { channelId: '123456789012345678' },
    },
    ui: { theme: 'preserved-theme' },
    desktop: { keepAwake: false, git: { commitPreset: 'custom', commitTemplate: 'keep' } },
    voice: { enabled: true },
    agent: {
      defaultProvider: 'openai',
      outputStyle: 'minimal',
      guide: 'retired guide',
      profile: { lang: 'ko' },
      skills: { disabled: [] },
      mcpServers: { preserved: { command: 'keep' } },
      presets: [
        { id: 'providerless', name: 'PROVIDERLESS', model: 'providerless-model', tools: 'full' },
        { id: 'workflow-agent-custom-reader', name: 'WORKFLOW AGENT-CUSTOM-READER', provider: 'openai', model: 'custom-model', tools: 'full' },
      ],
      workflowRoutes: {
        explorer: { model: 'providerless-explore' },
      },
      fastModels: {
        'example/migrated': true,
        'example/explicit': true,
      },
      modelSettings: {
        'example/explicit': { fast: false, effort: 'high' },
      },
      agentMaintenance: { enabled: true, interval: '1h' },
      runtime: { unused: true },
      search: { model: 'providerless-search' },
      capabilities: { unused: true },
      modules: { memory: false, search: false, explore: { enabled: false }, keep: { enabled: true } },
    },
  }), 'utf8');

  try {
    process.env.MIXDOG_DATA_DIR = dataDir;
    const configModule = await import(`../src/runtime/agent/orchestrator/config.mjs?legacy-cleanup=${Date.now()}`);
    const loaded = configModule.loadConfig({ secrets: false });

    assert.equal(loaded.modelSettings['example/migrated'].fast, true);
    assert.equal(loaded.modelSettings['example/explicit'].fast, false);
    assert.equal(loaded.defaultProvider, undefined);
    assert.equal(loaded.presets.some((preset) => preset.id === 'providerless'), false);
    assert.deepEqual(loaded.searchRoute, { provider: 'default', model: 'default' });
    assert.equal(loaded.agents.explore, undefined);
    assert.deepEqual(loaded.agents['custom-reader'], { provider: 'openai', model: 'custom-model' });
    assert.equal(loaded.recap.enabled, false);
    assert.deepEqual(loaded.modules, {
      search: { enabled: false },
      explore: { enabled: false },
      keep: { enabled: true },
    });
    assert.equal(Object.hasOwn(loaded, 'fastModels'), false);
    assert.equal(Object.hasOwn(loaded, 'agentMaintenance'), false);
    assert.equal(Object.hasOwn(loaded, 'runtime'), false);

    const migratedRoot = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(migratedRoot.outputStyle, 'minimal');
    assert.equal(migratedRoot.autoClear, undefined);
    assert.equal(migratedRoot.compaction, undefined);
    assert.equal(migratedRoot.shell, undefined);
    assert.equal(migratedRoot.search, undefined);
    assert.equal(migratedRoot.capabilities, undefined);
    assert.deepEqual(migratedRoot.memory, {
      user: { locale: 'ko' },
      cycle1: { interval: '7m' },
      embedding: { model: 'keep-me' },
    });
    assert.deepEqual(migratedRoot.ui, { theme: 'preserved-theme' });
    assert.deepEqual(migratedRoot.desktop, {
      keepAwake: false,
      git: { commitPreset: 'custom', commitTemplate: 'keep' },
    });
    assert.deepEqual(migratedRoot.voice, { enabled: true });
    assert.equal(migratedRoot.channels.promptInjection, undefined);
    assert.equal(migratedRoot.channels.schedules, undefined);
    assert.equal(migratedRoot.channels.nonInteractive, undefined);
    assert.equal(migratedRoot.channels.interactive, undefined);
    assert.deepEqual(migratedRoot.channels.channel, {});
    assert.deepEqual(migratedRoot.agent.autoClear, { enabled: false, idleMs: 60000 });
    assert.deepEqual(migratedRoot.agent.compaction, { auto: false, type: 'semantic' });
    assert.deepEqual(migratedRoot.agent.shell, { timeoutMs: 9876, command: 'pwsh' });
    assert.equal(migratedRoot.agent.profile.title, 'Preserved title');
    assert.equal(migratedRoot.agent.profile.language, 'ko');
    assert.deepEqual(migratedRoot.agent.mcpServers.preserved, { command: 'keep' });
    assert.equal(migratedRoot.agent.defaultProvider, undefined);
    assert.equal(migratedRoot.agent.guide, undefined);
    assert.equal(migratedRoot.agent.skills, undefined);

    configModule.saveConfig(loaded);
    const savedAgent = JSON.parse(readFileSync(configPath, 'utf8')).agent;
    assert.equal(savedAgent.modelSettings['example/migrated'].fast, true);
    assert.equal(savedAgent.modelSettings['example/explicit'].fast, false);
    assert.equal(Object.hasOwn(savedAgent, 'fastModels'), false);
    assert.equal(Object.hasOwn(savedAgent, 'agentMaintenance'), false);
    assert.equal(Object.hasOwn(savedAgent, 'runtime'), false);
    assert.equal(Object.hasOwn(savedAgent, 'workflowRoutes'), false);
    assert.equal(Object.hasOwn(savedAgent, 'search'), false);
    assert.equal(Object.hasOwn(savedAgent, 'capabilities'), false);
    assert.equal(savedAgent.defaultProvider, undefined);
    assert.equal(savedAgent.guide, undefined);
    assert.equal(savedAgent.skills, undefined);
    assert.deepEqual(savedAgent.modules, {
      search: { enabled: false },
      explore: { enabled: false },
      keep: { enabled: true },
    });
    assert.equal(savedAgent.autoClear.custom, undefined);
    assert.equal(savedAgent.autoClear.thresholdMs, undefined);
    assert.equal(savedAgent.autoClear.providerDefaults, undefined);
    assert.deepEqual(savedAgent.compaction, { auto: false, type: 'semantic' });
    assert.deepEqual(savedAgent.searchRoute, { provider: 'default', model: 'default' });
    assert.equal(savedAgent.presets.some((preset) => preset.id === 'providerless'), false);
    assert.equal(savedAgent.presets.some((preset) => preset.id === 'workflow-agent-custom-reader'), false);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
