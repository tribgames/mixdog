import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

register(new URL('./test-css-loader.mjs', import.meta.url));
const { SettingsView, preloadSettings } = await import('./SettingsView.tsx');
const { OnboardingWizard } = await import('./OnboardingWizard.tsx');
const { CommandSurface } = await import('../CommandSurface.tsx');
const { StatusPopover } = await import('../StatusPopover.tsx');
const { SETTINGS_ITEMS } = await import('./settings-items.ts');
const { SETTINGS_CATEGORIES } = await import('./settings-items.ts');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let dom;
let root;

function mount() {
  dom = new JSDOM('<!doctype html><html><body><button id="before">Before</button><main id="background"><div id="root"></div></main></body></html>', {
    url: 'http://localhost',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    FormData: dom.window.FormData,
  });
  dom.window.HTMLElement.prototype.attachEvent ??= () => {};
  dom.window.HTMLElement.prototype.detachEvent ??= () => {};
  root = createRoot(document.getElementById('root'));
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  dom?.window.close();
  root = undefined;
  dom = undefined;
});

const VALUES = [
  'profile', 'autoclear', 'autocompact', 'compact-type', 'channels', 'remote-runtime',
  'channel-backend', 'channel-setting', 'output-style', 'theme', 'workflow', 'model',
  'search', 'providers', 'mcp', 'plugins', 'hooks', 'skills', 'system-shell', 'update',
];
const LABELS = [
  'Profile', 'Auto-clear', 'Auto-compact', 'Compact type', 'Channels enabled', 'Remote Runtime',
  'Channel', 'Setting', 'Output style', 'Theme', 'Workflow', 'Model', 'Search model', 'Providers',
  'MCP servers', 'Plugins', 'Hooks', 'Skills', 'System shell', 'Update',
];
const DESCRIPTIONS = [
  'Your title and response language.',
  'Idle auto-clear disabled. Enter for options.',
  'Compact when context is high.',
  'Uses Memory recall to rebuild context faster on large histories.',
  'Discord, schedules, and webhooks.',
  'runtime stopped',
  'Left/Right or Enter changes channel type (Discord or Telegram).',
  'Configure credentials and main channel/chat for the active type.',
  'Response tone and format.',
  'TUI color theme.',
  'Active agent routing profile.',
  'Main chat model.',
  'Native search model.',
  'Auth, API keys, OAuth, local.',
  '0/0 connected',
  '0 detected',
  '0 before-tool rules',
  '0 available',
  'Use the platform default shell command.',
  'Check version and update mixdog.',
];

function capabilityApi(overrides = {}) {
  const values = {
    getProfile: { title: 'Owner', language: 'system', languages: [{ id: 'system', label: 'System' }] },
    getAutoClear: { enabled: true, idleMs: 3_600_000, provider: 'default', providerDefaults: [] },
    getCompactionSettings: { auto: false },
    getMemorySettings: { enabled: true },
    getChannelSettings: { enabled: true },
    isRemoteEnabled: false,
    getChannelWorkerStatus: { running: false },
    getChannelSetup: {
      backend: 'discord',
      discord: { authenticated: true, status: 'On' },
      telegram: { authenticated: false, status: 'Off' },
      channel: { discordChannelId: '111', telegramChatId: '' },
    },
    listWorkflows: [{ id: 'default', name: 'Default', active: true }],
    listOutputStyles: { configured: 'default', current: { id: 'default', label: 'Default' }, styles: [] },
    listThemes: [{ id: 'basic', label: 'Basic' }],
    getTheme: 'basic',
    getSearchRoute: { provider: 'default', model: 'default' },
    listSearchModels: [],
    getProviderSetup: { api: [], oauth: [], local: [] },
    mcpStatus: { connectedCount: 1, configuredCount: 1, failedCount: 0, servers: [] },
    pluginsStatus: { count: 2, plugins: [] },
    hooksStatus: { ruleCount: 3, rules: [] },
    skillsStatus: { count: 4, skills: [] },
    getDisabledSkills: { disabled: [] },
    getSystemShell: { source: 'auto', command: '', effective: 'powershell.exe' },
    getUpdateSettings: { currentVersion: '1.2.3', autoUpdate: false },
    getUpdateStatus: { phase: 'idle' },
    ...overrides,
  };
  const calls = [];
  const readCalls = [];
  return {
    calls,
    readCalls,
    api: {
      readCapabilities: async (requests) => {
        readCalls.push(requests);
        return requests.map(({ capability }) => ({
          ok: true,
          value: values[capability] ?? { ok: true },
        }));
      },
      invokeCapability: async ({ capability, args = [] }) => {
        if (/^(set|toggle|check|run|save|add|remove|delete)/.test(capability)) calls.push([capability, args]);
        return { value: values[capability] ?? { ok: true }, snapshot: { items: [], queued: [] } };
      },
      listProviderModels: async () => values.__providerModels || [],
      setModelRoute: async (selection) => { calls.push(['setModelRoute', [selection]]); },
      getSnapshot: async () => values.__snapshot || ({ items: [], queued: [] }),
    },
  };
}

async function renderSettings(props = {}) {
  await act(async () => {
    root.render(React.createElement(SettingsView, { onClose() {}, ...props }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('switching settings categories resets the shared pane scroll position', async () => {
  mount();
  const { api } = capabilityApi();
  await renderSettings({ api });
  const body = document.querySelector('.mixdog-settings__body');
  body.scrollTop = 240;
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Models').click();
    await Promise.resolve();
  });
  assert.equal(body.scrollTop, 0);
});

test('SETTINGS_ITEMS is the exact TUI row registry and order', () => {
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.value), VALUES);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.label), LABELS);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.description), DESCRIPTIONS);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.kind), [
    'open', 'toggle', 'toggle', 'static', 'toggle', 'toggle', 'cycle', 'open', 'open',
    'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open',
  ]);
  for (const item of SETTINGS_ITEMS) {
    assert.deepEqual(Object.keys(item), ['value', 'label', 'description', 'kind']);
  }
});

test('background preload prepares every settings surface and opening reuses the shared cache', async () => {
  mount();
  const { api, readCalls } = capabilityApi();
  await preloadSettings(api);
  assert.equal(readCalls.length, 1);
  const capabilities = readCalls[0].map((request) => request.capability);
  assert.ok(capabilities.includes('getProfile'));
  assert.ok(capabilities.includes('getProviderSetup'));
  assert.ok(capabilities.includes('getChannelSetup'));
  assert.ok(capabilities.includes('getSystemShell'));

  await renderSettings({ api });
  assert.equal(readCalls.length, 1, 'opening should reuse the background preload');
  assert.doesNotMatch(document.body.textContent, /Loading settings/);
  assert.equal(document.querySelector('input[name="title"]')?.value, 'Owner');
});

test('settings renders the flat settings-v2 rail and inline General groups', async () => {
  mount();
  const { api, calls } = capabilityApi();
  await renderSettings({ api });
  assert.deepEqual(
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'), (node) => node.textContent),
    SETTINGS_CATEGORIES.map((item) => item.label),
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll('.mixdog-settings__rail-group > h2'), (node) => node.textContent),
    ['Integrations', 'Support'],
  );
  assert.deepEqual(SETTINGS_CATEGORIES.slice(0, 4).map((item) => item.label),
    ['General', 'Models', 'Workflows', 'Output style']);
  assert.equal(document.querySelectorAll('.mixdog-settings__rail button.active').length, 1);
  assert.equal(document.querySelector('.mixdog-settings__picker-list') === null, true,
    'selector .mixdog-settings__picker-list should be absent');
  assert.equal(document.querySelector('button[aria-label="Back to settings"]') === null, true,
    'selector button[aria-label="Back to settings"] should be absent');
  assert.ok(document.querySelector('input[name="title"]'));
  assert.match(document.querySelector('[aria-label="Theme"]')?.textContent || '', /Dark/);
  assert.equal(document.querySelector('.settings-theme-choice'), null);
  assert.ok(document.querySelector('input[aria-label="Auto-clear"]'));
  assert.ok(document.querySelector('input[aria-label="Auto-compact"]'));
  assert.deepEqual(
    Array.from(document.querySelectorAll('.mixdog-settings__row-title'), (node) => node.textContent)
      .filter((title) => title === 'Auto-compact' || title === 'Auto-clear'),
    ['Auto-compact', 'Auto-clear'],
  );
  assert.doesNotMatch(document.body.textContent, /Compaction strategy|Recall fast-track/);
  assert.doesNotMatch(document.body.textContent, /Zoom/);
  const title = document.querySelector('input[name="title"]');
  assert.equal(title.closest('.settings-form-row').querySelector('button') === null, true,
    'the general title row should not render an action button');
  await act(async () => {
    title.value = 'Builder';
    title.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setProfile' && args[0]?.title === 'Builder'));
});

test('rail tabs swap the pane for every depth surface without subpages', async () => {
  mount();
  const { api, calls } = capabilityApi({
    listOutputStyles: {
      configured: 'default',
      current: { id: 'default', label: 'Default' },
      styles: [{ id: 'default', label: 'Default' }, { id: 'minimal', label: 'Minimal' }],
    },
  });
  await renderSettings({ api, initialSection: null });
  const open = async (label) => {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === label).click();
      await Promise.resolve();
    });
  };
  for (const [label, expected] of [
    ['Output style', /Minimal/],
    ['MCP', /No MCP servers configured/],
    ['Plugins', /Install plugin/],
    ['Hooks', /No hook rules configured/],
    ['Skills', /No skills found/],
    ['Memory', /Core memories/],
    ['System', /Run doctor/],
  ]) {
    await open(label);
    assert.equal(document.querySelector('.mixdog-settings__header h1')?.textContent, label);
    assert.match(document.body.textContent, expected);
    assert.equal(document.querySelector('button[aria-label="Back to settings"]') === null, true,
      'selector button[aria-label="Back to settings"] should be absent');
  }
});

test('settings rows omit descriptions across primary panels', async () => {
  mount();
  const { api } = capabilityApi({
    getProviderSetup: {
      api: [{ id: 'openai', name: 'OpenAI', detail: 'API-key provider' }],
      oauth: [],
      local: [],
    },
    mcpStatus: {
      connectedCount: 1,
      configuredCount: 1,
      servers: [{ name: 'docs', transport: 'stdio', status: 'connected', enabled: true }],
    },
  });
  await renderSettings({ api });
  const assertNoRowDescriptions = () => {
    assert.equal(document.querySelectorAll(
      '.mixdog-settings__description, .settings-form-row small, .settings-resource p',
    ).length, 0);
  };
  assertNoRowDescriptions();
  for (const category of ['Models', 'Workflows', 'Providers', 'Channels', 'MCP', 'Hooks']) {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === category).click();
      await Promise.resolve();
    });
    assertNoRowDescriptions();
  }
});

test('category panes expose TUI routes, automation, memory, voice, and doctor controls without desktop-only zoom', async () => {
  mount();
  const { api } = capabilityApi({
    listAgents: [{ id: 'lead', name: 'Lead', route: { provider: 'default', model: 'default' } }],
    getChannelSetup: {
      backend: 'discord',
      channel: {},
      schedules: [{ name: 'daily', time: '0 9 * * *', enabled: true }],
      webhooks: [{ name: 'github', parser: 'github', enabled: true, secretSet: true }],
    },
    getVoiceStatus: {
      installed: true,
      enabled: true,
      components: { whisper: true, model: true, ffmpeg: true },
    },
  });
  await renderSettings({ api });
  assert.doesNotMatch(document.body.textContent, /Zoom/);
  for (const [category, expected] of [
    ['Models', /Main route.*Search route/s],
    ['Workflows', /Workflow packs.*Agent routes/s],
    ['Channels', /Voice transcription.*Disable voice.*Schedules.*daily.*Webhook endpoints.*github/s],
    ['Memory', /Core memories/],
    ['System', /Run doctor/],
  ]) {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === category).click();
      await Promise.resolve();
    });
    assert.match(document.body.textContent, expected);
  }
});

test('flattened panes commit provider, TUI-safe MCP and hook toggles, and model-route mutations', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getProviderSetup: {
      api: [{ id: 'anthropic', name: 'Anthropic', authenticated: false }],
      oauth: [{ id: 'openai', name: 'OpenAI OAuth', authenticated: true, enabled: true }],
      local: [],
    },
    mcpStatus: {
      connectedCount: 1,
      configuredCount: 1,
      servers: [{ name: 'existing-mcp', transport: 'stdio', status: 'connected', enabled: true }],
    },
    hooksStatus: {
      ruleCount: 1,
      rules: [{ index: 0, tool: 'shell', action: 'ask', enabled: true }],
    },
    __providerModels: [
      { provider: 'openai', model: 'gpt-current', display: 'Current', effortOptions: [], fastCapable: false, fastPreferred: false },
      { provider: 'openai', model: 'gpt-next', display: 'Next', effortOptions: [], fastCapable: false, fastPreferred: false },
    ],
    __snapshot: { provider: 'openai', model: 'gpt-current', effort: 'auto', fast: false },
  });
  await renderSettings({ api });

  const openCategory = async (label) => {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === label).click();
      await Promise.resolve();
    });
  };
  const submit = async (form) => {
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await openCategory('Providers');
  const providerForm = document.querySelector('input[name="secret"]').closest('form');
  providerForm.querySelector('input[name="secret"]').value = 'sk-test';
  await submit(providerForm);
  assert.ok(calls.some(([name, args]) => name === 'saveProviderApiKey'
    && args[0] === 'anthropic' && args[1] === 'sk-test'));

  await openCategory('MCP');
  assert.equal(document.querySelector('input[name="commandOrUrl"]') === null, true,
    'selector input[name="commandOrUrl"] should be absent');
  const mcpRow = Array.from(document.querySelectorAll('.settings-resource'))
    .find((row) => row.textContent.includes('existing-mcp'));
  assert.equal(mcpRow.querySelector('button.danger') === null, true,
    'the MCP row should not render a danger button');
  await act(async () => {
    mcpRow.querySelector('button').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setMcpServerEnabled'
    && args[0] === 'existing-mcp' && args[1] === false));

  await openCategory('Hooks');
  assert.equal(document.querySelector('input[name="tool"]') === null, true,
    'selector input[name="tool"] should be absent');
  const hookRow = Array.from(document.querySelectorAll('.settings-resource'))
    .find((row) => row.textContent.includes('shell → ask'));
  assert.equal(hookRow.querySelector('button.danger') === null, true,
    'the hook row should not render a danger button');
  await act(async () => {
    hookRow.querySelector('button').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setHookRuleEnabled'
    && args[0] === 0 && args[1] === false));

  await openCategory('Models');
  const modelRow = document.querySelector('button[aria-label="Model"]').closest('.mixdog-settings__row');
  const effortRow = document.querySelector('button[aria-label="Effort"]').closest('.mixdog-settings__row');
  assert.notEqual(modelRow, effortRow);
  assert.equal(modelRow.querySelector('.mixdog-settings__row-title').textContent, 'Model');
  assert.equal(effortRow.querySelector('.mixdog-settings__row-title').textContent, 'Effort');
  await act(async () => document.querySelector('button[aria-label="Model"]').click());
  assert.ok(document.querySelector('.model-picker-dialog'));
  assert.ok(document.querySelector('input[aria-label="Search models"]'));
  await act(async () => {
    Array.from(document.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.includes('Next')).click();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setModelRoute'
    && args[0]?.provider === 'openai' && args[0]?.model === 'gpt-next'));
});

test('Models keeps search controls separate while Workflows owns agent routes', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getProviderSetup: {
      api: [],
      oauth: [{ id: 'openai', name: 'OpenAI OAuth', authenticated: true, enabled: true }],
      local: [],
    },
    getSearchRoute: { provider: 'openai', model: 'gpt-search', effort: 'high', fast: true },
    listSearchModels: [{
      provider: 'openai',
      model: 'gpt-search',
      display: 'Search',
      effortOptions: [{ value: 'high', label: 'High' }],
      fastCapable: true,
      fastPreferred: true,
    }],
    listAgents: [{
      id: 'worker',
      name: 'Worker',
      workflowSlot: 'worker',
      route: { provider: 'openai', model: 'gpt-worker', effort: 'high', fast: true },
    }],
    __providerModels: [{
      provider: 'openai',
      model: 'gpt-worker',
      display: 'Worker',
      effortOptions: [{ value: 'high', label: 'High' }],
      fastCapable: true,
      fastPreferred: true,
    }],
  });
  await renderSettings({ api });
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Models').click();
    await Promise.resolve();
  });
  const searchGroup = Array.from(document.querySelectorAll('.settings-group'))
    .find((group) => group.querySelector('h3')?.textContent === 'Search route');
  const searchModel = searchGroup.querySelector('button[aria-label="Web-search model"]');
  const searchEffort = searchGroup.querySelector('button[aria-label="Effort"]');
  const searchFast = searchGroup.querySelector('button[aria-label="Fast mode"]');
  assert.ok(searchModel);
  assert.ok(searchEffort);
  assert.ok(searchFast);
  assert.notEqual(searchModel.closest('.mixdog-settings__row'), searchEffort.closest('.mixdog-settings__row'));
  assert.ok(searchModel.closest('.settings-route-row'));
  assert.ok(searchEffort.closest('.effort-control'));
  assert.ok(searchFast.closest('.fast-control'));
  assert.match(searchFast.textContent, /Fast On/);
  assert.equal(searchGroup.querySelector('input[type="checkbox"]') === null, true,
    'the search group should not render a checkbox');
  await act(async () => {
    searchFast.click();
    await Promise.resolve();
  });
  await act(async () => {
    Array.from(document.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.trim() === 'Fast Off').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setSearchRoute' && args[0]?.fast === false));
  assert.doesNotMatch(document.body.textContent, /Workflow packs|Agent routes/);
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Workflows').click();
    await Promise.resolve();
  });
  const workerRow = Array.from(document.querySelectorAll('.settings-resource'))
    .find((row) => row.textContent.includes('Worker'));
  assert.ok(workerRow.classList.contains('settings-agent-route'));
  assert.equal(workerRow.querySelectorAll('.settings-route-controls > *').length, 3);
  const workerFast = workerRow.querySelector('button[aria-label="Worker route fast mode"]');
  assert.match(workerFast.textContent, /Fast On/);
  assert.equal(workerRow.querySelector('input[type="checkbox"]') === null, true,
    'the worker row should not render a checkbox');
  await act(async () => {
    workerFast.click();
    await Promise.resolve();
  });
  await act(async () => {
    Array.from(document.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent.trim() === 'Fast Off').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setAgentRoute'
    && args[0] === 'worker' && args[1]?.fast === false));
  assert.equal(workerRow.querySelector('.settings-meta') === null, true,
    'the worker row should not render settings metadata');
  assert.doesNotMatch(workerRow.textContent, /explorer|fixed slot/i);
});

test('selected output styles and workflows use Active status badges without internal metadata labels', async () => {
  mount();
  const { api } = capabilityApi({
    listOutputStyles: {
      configured: 'simple',
      current: { id: 'simple', label: 'Simple' },
      styles: [{ id: 'default', label: 'Default' }, { id: 'simple', label: 'Simple' }],
    },
    listWorkflows: [{ id: 'solo', name: 'Solo', active: true, source: 'internal-workflow' }],
    listAgents: [{
      id: 'explore',
      name: 'Explore',
      workflowSlot: 'explorer',
      route: { provider: 'default', model: 'default' },
    }],
  });
  await renderSettings({ api });
  const open = async (label) => {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === label).click();
      await Promise.resolve();
    });
  };
  await open('Output style');
  const simple = Array.from(document.querySelectorAll('.settings-resource'))
    .find((row) => row.textContent.includes('Simple'));
  assert.equal(simple.querySelector('.settings-status')?.textContent, 'Active');
  assert.ok(simple.querySelector('.settings-status--positive'));
  assert.equal(simple.querySelector('.settings-selected-check') === null, true,
    'the simple option should not render a selected check');
  await open('Workflows');
  const solo = Array.from(document.querySelectorAll('.settings-resource'))
    .find((row) => row.textContent.includes('Solo'));
  assert.equal(solo.querySelector('.settings-status')?.textContent, 'Active');
  assert.ok(solo.querySelector('.settings-status--positive'));
  assert.doesNotMatch(document.body.textContent, /internal-workflow|explorer|fixed slot/i);
});

test('status badges stay with row titles while metadata and actions remain separate', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getProviderSetup: {
      api: [
        { id: 'openai', name: 'OpenAI', authenticated: true, stored: true },
        { id: 'anthropic', name: 'Anthropic', authenticated: false, status: 'not connected' },
      ],
      oauth: [{ id: 'openai-oauth', name: 'OpenAI OAuth', authenticated: true, enabled: true }],
      local: [
        { id: 'ollama', name: 'Ollama', status: 'enabled', detected: true, enabled: true, baseURL: 'http://localhost:11434/v1' },
        { id: 'lmstudio', name: 'LM Studio', status: 'off', detected: true, enabled: false, baseURL: 'http://localhost:1234/v1' },
      ],
    },
    mcpStatus: {
      connectedCount: 1,
      configuredCount: 1,
      failedCount: 0,
      servers: [{ name: 'docs', status: 'connected', toolCount: 3, enabled: true }],
    },
    getChannelSetup: {
      backend: 'discord',
      discord: { stored: true, status: 'set' },
      telegram: { stored: true, status: 'set' },
      webhook: { stored: true, status: 'set' },
      channel: { discordChannelId: '111', telegramChatId: '222' },
    },
  });
  await renderSettings({ api });
  const open = async (label) => {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === label).click();
      await Promise.resolve();
    });
  };
  await open('Providers');
  assert.deepEqual(
    Array.from(document.querySelectorAll('.settings-group > header h3'), (node) => node.textContent),
    ['OAuth providers', 'API-key providers', 'Local providers'],
  );
  assert.doesNotMatch(document.body.textContent, /Save API key/);
  const providerRows = Array.from(document.querySelectorAll('.settings-resource'));
  const connected = providerRows.find((row) => row.textContent.includes('OpenAI'));
  const disconnected = providerRows.find((row) => row.textContent.includes('Anthropic'));
  assert.equal(connected.querySelector('.settings-status')?.textContent, 'Connected');
  assert.ok(connected.querySelector('.settings-status--positive'));
  assert.equal(disconnected.querySelector('.settings-status')?.textContent, 'Not connected');
  assert.ok(disconnected.querySelector('.settings-status--neutral'));
  assert.equal(connected.querySelector('.settings-resource-control .settings-status') === null, true,
    'the connected resource control should not duplicate its status');
  assert.ok(disconnected.querySelector('input[aria-label="Anthropic API key"]'));
  const localForms = Array.from(document.querySelectorAll('.settings-form-row'))
    .filter((row) => /endpoint/.test(row.textContent));
  assert.deepEqual(localForms.map((row) => row.querySelector('button')?.textContent), ['Save', 'Save']);
  const lmStudioEndpoint = document.querySelector('input[aria-label="LM Studio endpoint"]');
  lmStudioEndpoint.value = 'http://localhost:5678/v1';
  await act(async () => {
    lmStudioEndpoint.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setLocalProvider'
    && args[0] === 'lmstudio' && args[1]?.enabled === false
    && args[1]?.baseURL === 'http://localhost:5678/v1'));
  await open('MCP');
  const server = Array.from(document.querySelectorAll('.settings-resource'))
    .find((row) => row.textContent.includes('docs'));
  assert.equal(server.querySelector('.settings-status')?.textContent, 'Connected');
  assert.equal(server.querySelector('.settings-resource-meta')?.textContent, '3 tools');
  assert.equal(server.querySelector('.settings-resource-control .settings-status') === null, true,
    'the server resource control should not duplicate its status');
  await open('Channels');
  for (const title of ['Discord bot token', 'Telegram bot token', 'ngrok auth token']) {
    const form = document.querySelector(`input[aria-label="${title}"]`).closest('.settings-form-row');
    assert.ok(form.firstElementChild.classList.contains('settings-resource-title'));
    assert.equal(form.firstElementChild.querySelector('.settings-status')?.textContent, 'Saved');
    assert.equal(form.querySelector('.settings-form-controls .settings-status') === null, true,
      `${title} controls should not contain the Saved status`);
  }
});

test('inline toggles and channel cycle use the TUI capability semantics', async () => {
  mount();
  const { api, calls } = capabilityApi();
  await renderSettings({ api });
  await act(async () => {
    document.querySelector('input[aria-label="Auto-compact"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(calls[0], ['setCompactionSettings', [{ auto: true }]]);

  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Channels').click();
    await Promise.resolve();
  });
  const channel = document.querySelector('button[aria-label="Channel"]');
  await act(async () => channel.click());
  const telegram = Array.from(document.querySelectorAll('[role="option"]'))
    .find((entry) => entry.textContent.trim() === 'Telegram');
  await act(async () => { telegram.click(); await Promise.resolve(); });
  assert.deepEqual(calls[1], ['setBackend', ['telegram']]);
});

test('channel backend change surfaces restart guidance while the remote worker runs', async () => {
  mount();
  const { api } = capabilityApi({
    isRemoteEnabled: true,
    getChannelWorkerStatus: { running: true, pid: 42 },
  });
  await renderSettings({ api });
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Channels').click();
    await Promise.resolve();
  });
  const channel = document.querySelector('button[aria-label="Channel"]');
  await act(async () => channel.click());
  const telegram = Array.from(document.querySelectorAll('[role="option"]'))
    .find((entry) => entry.textContent.trim() === 'Telegram');
  await act(async () => { telegram.click(); await Promise.resolve(); await Promise.resolve(); });
  assert.match(document.querySelector('[role="status"]')?.textContent || '', /Channel set to Telegram\. Restart remote to apply\./);
});

test('General keeps the Auto-clear switch and provider idle windows inline', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getAutoClear: {
      enabled: true,
      idleMs: 3_600_000,
      providerDefaults: [{ provider: 'openai', idleMs: 600_000, builtInMs: 3_600_000, custom: true }],
    },
  });
  await renderSettings({ api });
  assert.equal(document.querySelector('button[aria-label="Open Auto-clear options"]') === null, true,
    'selector button[aria-label="Open Auto-clear options"] should be absent');
  assert.match(document.body.textContent, /idle window/);
  assert.ok(document.querySelector('input[aria-label="Auto-clear"]'));
  assert.ok(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Reset'));
  const duration = document.querySelector('input[name="duration"]');
  assert.equal(duration.value, '10m');
  assert.equal(Array.from(duration.closest('.settings-form-row').querySelectorAll('button'))
    .some((button) => button.textContent === 'Save'), false);
  await act(async () => {
    duration.value = '45m';
    duration.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setAutoClear'
    && args[0]?.provider === 'openai' && args[0]?.duration === '45m'));
});

test('channel-setting deep link opens the Channels tab with token and target forms', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getChannelSetup: {
      backend: 'discord',
      discord: { authenticated: true, stored: true, status: 'Set' },
      telegram: { authenticated: true, stored: true, status: 'Set' },
      channel: { discordChannelId: '111', telegramChatId: '222' },
    },
  });
  await renderSettings({ api, initialSection: 'channel-setting' });
  assert.equal(document.querySelector('.mixdog-settings__rail button.active')?.textContent, 'Channels');
  assert.equal(document.querySelector('button[aria-label="Back to settings"]') === null, true,
    'selector button[aria-label="Back to settings"] should be absent');
  assert.match(document.body.textContent, /Discord bot token/);
  assert.match(document.body.textContent, /Telegram bot token/);
  assert.match(document.body.textContent, /Main channel/);
  assert.match(document.body.textContent, /Main chat/);
  assert.match(document.body.textContent, /ngrok domain/);
  for (const title of ['Discord bot token', 'Telegram bot token']) {
    const input = document.querySelector(`input[aria-label="${title}"]`);
    const row = input.closest('.settings-form-row');
    assert.match(input.placeholder, /Saved/);
    assert.equal(row.querySelector('.settings-status')?.textContent, 'Saved');
    assert.ok(row.querySelector('.settings-status--positive'));
    assert.equal(row.querySelector('button')?.textContent, 'Replace');
  }
  const channel = document.querySelector('input[aria-label="Main channel"]');
  assert.equal(channel.closest('.settings-form-row').querySelector('button') === null, true,
    'the channel row should not render an action button');
  await act(async () => {
    channel.value = '222';
    channel.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setChannel'
    && args[0]?.backend === 'discord' && args[0]?.channelId === '222'));
});

test('General exposes only System, White, and Dark with persistent desktop preference', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getTheme: 'basic',
  });
  await renderSettings({ api, initialSection: 'theme' });
  assert.equal(document.querySelector('.mixdog-settings__rail button.active')?.textContent, 'General');
  assert.equal(Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
    .some((button) => button.textContent === 'Theme'), false);
  assert.equal(document.querySelector('button[aria-label="Back to settings"]') === null, true,
    'selector button[aria-label="Back to settings"] should be absent');
  const theme = document.querySelector('[aria-label="Theme"]');
  assert.match(theme?.textContent || '', /Dark/);
  await act(async () => {
    theme.click();
    await Promise.resolve();
  });
  assert.deepEqual(Array.from(document.querySelectorAll('.oc-menu[aria-label="Theme"] [role="option"]'),
    (node) => node.textContent.trim()), ['System', 'White', 'Dark']);
  const white = Array.from(document.querySelectorAll('.oc-menu[aria-label="Theme"] [role="option"]'))
    .find((entry) => entry.textContent.includes('White'));
  await act(async () => {
    white.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([capability, args]) => capability === 'setTheme'
    && args[0] === 'light' && args[1]?.persist === true));
  assert.equal(document.documentElement.dataset.mixdogTheme, 'light');
  assert.equal(window.localStorage.getItem('mixdog.desktop-theme-preference'), 'white');
});

test('System shell is shared by the TUI registry and Desktop capability editor', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getSystemShell: { source: 'config', command: 'powershell.exe', effective: 'powershell.exe' },
  });
  await renderSettings({ api, initialSection: 'system-shell' });
  assert.equal(document.querySelector('.mixdog-settings__header h1')?.textContent, 'System');
  assert.match(document.body.textContent, /Effective shellConfiguredpowershell\.exe/);
  const input = document.querySelector('input[aria-label="System shell command"]');
  assert.equal(input.value, 'powershell.exe');
  await act(async () => {
    input.focus();
    input.value = 'pwsh';
    input.blur();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setSystemShell' && args[0] === 'pwsh'));

  const automatic = Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent === 'Use automatic');
  await act(async () => {
    automatic.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([name, args]) => name === 'setSystemShell' && args[0] === ''));
});

test('update auto-checks on open and Update now runs without confirmation', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getUpdateSettings: { currentVersion: '1.2.3', latestVersion: '1.2.4', updateAvailable: true },
  });
  await renderSettings({ api, initialSection: 'update' });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.ok(calls.some(([capability, args]) => capability === 'checkForUpdate' && args.length === 1));
  const update = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Update to'));
  await act(async () => { update.click(); await Promise.resolve(); });
  assert.ok(calls.some(([capability]) => capability === 'runUpdateNow'));
  assert.equal(document.querySelector('[role="alertdialog"]') === null, true,
    'selector [role="alertdialog"] should be absent');
});

test('plugins expose MCP enable only for script-backed MCP', async () => {
  mount();
  const { api } = capabilityApi({
    pluginsStatus: {
      count: 3,
      plugins: [
        { id: 'inline', name: 'Inline', mcpInline: true },
        { id: 'script', name: 'Script', mcpScript: 'scripts/run-mcp.mjs' },
        { id: 'local', name: 'Local', sourceType: 'local', mcpScript: 'scripts/local-mcp.mjs', mcpEnabled: true },
      ],
    },
  });
  await renderSettings({ api, initialSection: 'plugins' });
  const pluginRows = Array.from(document.querySelectorAll('.settings-resource'));
  assert.doesNotMatch(pluginRows.find((row) => row.textContent.includes('Inline')).textContent, /Enable MCP/);
  assert.match(pluginRows.find((row) => row.textContent.includes('Script')).textContent, /Enable MCP/);
  assert.match(pluginRows.find((row) => row.textContent.includes('Local')).textContent, /Update metadata/);
  assert.match(pluginRows.find((row) => row.textContent.includes('Local')).textContent, /Reconfigure MCP/);
  assert.doesNotMatch(document.body.textContent, /Refresh metadata|Refresh MCP/);
});

test('empty resource collections use full list rows across settings categories', async () => {
  mount();
  const { api } = capabilityApi({ listAgents: [], listWorkflows: [] });
  await renderSettings({ api });
  const expected = new Map([
    ['Workflows', ['No workflows found.', 'No agent routes found.']],
    ['Providers', ['No OAuth providers available.', 'No API-key providers available.', 'No local providers available.']],
    ['Channels', ['No schedules configured.', 'No webhook endpoints configured.']],
    ['MCP', ['No MCP servers configured.']],
    ['Plugins', ['No plugins installed.']],
    ['Hooks', ['No hook rules configured.']],
    ['Skills', ['No skills found.']],
  ]);
  for (const [category, messages] of expected) {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === category).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      Array.from(document.querySelectorAll('.settings-empty-list'), (node) => node.textContent),
      messages,
    );
  }
});

test('Memory separates input from rows, hides ids, sorts newest first, and reloads after changes', async () => {
  mount();
  const { api } = capabilityApi();
  const invokeCapability = api.invokeCapability;
  let listCalls = 0;
  api.invokeCapability = async (request) => {
    if (request.capability !== 'memoryControl') return invokeCapability(request);
    if (request.args?.[0]?.op !== 'list') return { value: 'Saved' };
    listCalls += 1;
    return { value: listCalls === 1
      ? 'COMMON:\nid=2 Older element — Older memory\nproject-alpha:\nid=7 Newest element — Newest memory\nid=4 Middle element — Middle memory'
      : 'COMMON:\nid=9 Added element — Added memory\nid=2 Older element — Older memory' };
  };
  await renderSettings({ api });
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Memory').click();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.ok(document.querySelector('.core-memory-add-card .core-memory-add'));
  assert.equal(document.querySelector('.core-memory-id') === null, true,
    'selector .core-memory-id should be absent');
  assert.deepEqual(
    Array.from(document.querySelectorAll('.core-memory-copy b'), (node) => node.textContent),
    ['Newest memory', 'Middle memory', 'Older memory'],
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll('.core-memory-scope'), (node) => node.textContent),
    ['project-alpha', 'project-alpha', 'Common'],
  );
  assert.equal(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Refresh memories'), false);

  const addForm = document.querySelector('.core-memory-add');
  const input = addForm.querySelector('input');
  input.value = 'Added memory';
  await act(async () => {
    addForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(listCalls, 2);
  assert.deepEqual(
    Array.from(document.querySelectorAll('.core-memory-copy b'), (node) => node.textContent),
    ['Added memory', 'Older memory'],
  );
});

test('entry-loaded command and runtime status surfaces omit manual Refresh controls', async () => {
  mount();
  const commandCalls = [];
  const api = {
    invokeCapability: async ({ capability }) => {
      commandCalls.push(capability);
      return { value: {} };
    },
    getSnapshot: async () => ({ items: [], queued: [] }),
  };
  await act(async () => {
    root.render(React.createElement(CommandSurface, {
      surface: 'context',
      api,
      onClose() {},
      onOpen() {},
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(commandCalls.includes('contextStatus'));
  assert.equal(Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === 'Refresh'), false);

  await act(async () => root.render(null));
  const statusCalls = [];
  window.mixdogDesktop = {
    invokeCapability: async ({ capability }) => {
      statusCalls.push(capability);
      return { value: { running: true, pid: 42 } };
    },
    getSnapshot: async () => ({ items: [], queued: [] }),
  };
  await act(async () => root.render(React.createElement(StatusPopover)));
  await act(async () => {
    document.querySelector('button[aria-label="Runtime status"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(statusCalls.includes('getChannelWorkerStatus'));
  assert.equal(Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === 'Refresh'), false);
});

test('modal closes on Escape and restores the exact prior focus', async () => {
  mount();
  const { api } = capabilityApi();
  const before = document.getElementById('before');
  before.focus();
  let closes = 0;
  await renderSettings({ api, onClose: () => { closes += 1; } });
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close settings');
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    root.render(null);
    await Promise.resolve();
  });
  assert.equal(closes, 1);
  assert.equal(document.activeElement === before, true,
    'closing settings should restore prior focus');
});

test('modal closes on its backdrop but stays open when the dialog is pressed', async () => {
  mount();
  const { api } = capabilityApi();
  let closes = 0;
  await renderSettings({ api, onClose: () => { closes += 1; } });
  const layer = document.querySelector('.mixdog-settings-layer');
  const dialog = document.querySelector('.mixdog-settings[role="dialog"]');

  await act(async () => {
    dialog.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  });
  assert.equal(closes, 0, 'pressing inside settings should not close the modal');

  await act(async () => {
    layer.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(closes, 1, 'pressing the settings backdrop should close the modal');
});

test('Settings lets a portaled select consume Escape without closing the dialog', async () => {
  mount();
  const { api } = capabilityApi();
  let closes = 0;
  await renderSettings({ api, onClose: () => { closes += 1; } });
  const select = document.querySelector('button[role="combobox"][aria-label="Language"]');
  await act(async () => {
    select.click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector('.oc-menu[role="listbox"]'));

  await act(async () => {
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.oc-menu[role="listbox"]') === null, true,
    'selector .oc-menu[role="listbox"] should be absent');
  assert.ok(document.querySelector('.mixdog-settings[role="dialog"]'));
  assert.equal(closes, 0);
  assert.equal(document.activeElement === select, true,
    'closing the select should restore trigger focus');
});

test('onboarding skip requires confirmation, cancels safely, and only skips after explicit approval', async () => {
  mount();
  const { api } = capabilityApi();
  const calls = [];
  const invokeCapability = api.invokeCapability;
  api.invokeCapability = async (request) => {
    calls.push(request.capability);
    return invokeCapability(request);
  };
  let completed = 0;
  await act(async () => {
    root.render(React.createElement(OnboardingWizard, { api, onDone: () => { completed += 1; } }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === 'Refresh'), false);

  const trigger = document.querySelector('.onboarding-dialog > footer > button.secondary');
  await act(async () => trigger.click());
  let confirmation = document.querySelector('[role="alertdialog"][aria-labelledby="onboarding-skip-title"]');
  assert.ok(confirmation);
  assert.equal(calls.includes('skipOnboarding'), false);
  assert.equal(document.activeElement === confirmation.querySelector('footer button'), true,
    'the confirmation should focus its footer action');

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('[role="alertdialog"]') === null, true,
    'selector [role="alertdialog"] should be absent');
  assert.equal(document.activeElement === trigger, true,
    'closing the confirmation should restore trigger focus');
  assert.equal(calls.includes('skipOnboarding'), false);

  await act(async () => trigger.click());
  confirmation = document.querySelector('[role="alertdialog"]');
  await act(async () => {
    Array.from(confirmation.querySelectorAll('button'))
      .find((button) => button.textContent === 'Skip setup').click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(calls.filter((capability) => capability === 'skipOnboarding').length, 1);
  assert.equal(completed, 1);
});

test('onboarding lets a portaled model menu consume Escape without opening skip confirmation', async () => {
  mount();
  const { api } = capabilityApi();
  await act(async () => {
    root.render(React.createElement(OnboardingWizard, { api, onDone() {} }));
    await Promise.resolve();
    await Promise.resolve();
  });
  const next = Array.from(document.querySelectorAll('.onboarding-dialog button'))
    .find((button) => button.textContent.includes('Next'));
  await act(async () => next.click());
  const select = document.querySelector('button[role="combobox"][aria-label="Main model"]');
  await act(async () => select.click());
  assert.ok(document.querySelector('.oc-menu[role="listbox"]'));

  await act(async () => {
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.oc-menu[role="listbox"]') === null, true,
    'selector .oc-menu[role="listbox"] should be absent');
  assert.equal(document.querySelector('[role="alertdialog"]') === null, true,
    'selector [role="alertdialog"] should be absent');
  assert.equal(document.activeElement === select, true,
    'closing the confirmation should restore select focus');
});
