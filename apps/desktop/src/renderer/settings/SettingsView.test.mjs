import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

register(new URL('./test-css-loader.mjs', import.meta.url));
const { SettingsView, preloadSettings, preloadConnectionInfo } = await import('./SettingsView.tsx');
const { OnboardingWizard } = await import('./OnboardingWizard.tsx');
const { default: i18next } = await import('../i18n.ts');
const { OAuthControl } = await import('./CapabilitySettings.tsx');
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
  await i18next.changeLanguage('en');
  dom?.window.close();
  root = undefined;
  dom = undefined;
});

const VALUES = [
  'model', 'search', 'workflow', 'output-style', 'profile', 'theme', 'web-search-enabled',
  'explorer-enabled', 'memory-enabled', 'autocompact', 'compact-type', 'autoclear',
  'memory', 'providers', 'mcp', 'plugins', 'hooks', 'skills',
  'channels', 'channel-provider', 'channel-setting', 'remote-runtime', 'update',
];
const LABELS = [
  'Model', 'Search model', 'Workflow', 'Output style', 'Profile', 'Theme', 'Web search',
  'Explorer', 'Memory', 'Auto-compact', 'Compact type', 'Auto-clear', 'Core memories',
  'Providers', 'MCP servers', 'Plugins', 'Hooks',
  'Skills', 'Channels enabled', 'Channel', 'Setting', 'Remote Runtime', 'Update',
];
const DESCRIPTIONS = [
  'Main chat model.',
  'Native search model.',
  'Active agent routing profile.',
  'Response tone and format.',
  'Your title and response language.',
  'TUI color theme.',
  'Expose web search and fetch tools to new sessions.',
  'Expose the repository locator tool to new sessions.',
  'Background cycles and model memory writes.',
  'Compact when context is high.',
  'Uses Memory recall to rebuild context faster on large histories.',
  'Idle auto-clear disabled. Enter for options.',
  'List and edit user-curated core memories.',
  'Auth, API keys, OAuth, local.',
  '0/0 connected',
  '0 detected',
  '0 before-tool rules',
  '0 available',
  'Discord and Telegram messaging.',
  'Left/Right or Enter changes channel type (Discord or Telegram).',
  'Configure credentials and main channel/chat for the active type.',
  'Stopped. Manual ON claims remote from any other session.',
  'Check version and update mixdog.',
];

function capabilityApi(overrides = {}) {
  const values = {
    getProfile: { title: 'Owner', language: 'system', languages: [{ id: 'system', label: 'System' }] },
    getAutoClear: { enabled: true, idleMs: 3_600_000, provider: 'default', providerDefaults: [] },
    getCompactionSettings: { auto: false },
    getRecapSettings: { enabled: true },
    getToolModuleSettings: { search: { enabled: true }, explore: { enabled: true } },
    getChannelSettings: { enabled: true },
    isRemoteEnabled: false,
    getChannelWorkerStatus: { running: false },
    getChannelSetup: {
      provider: 'discord',
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
  let updaterState = values.__updaterState || { status: 'idle' };
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
      getUpdaterState: async () => updaterState,
      subscribeUpdaterState: (listener) => {
        listener(updaterState);
        return () => {};
      },
      checkForDesktopUpdate: async () => {
        calls.push(['checkForDesktopUpdate', []]);
        updaterState = values.__checkedUpdaterState || updaterState;
        return updaterState;
      },
      showDesktopUpdate: async () => {
        calls.push(['showDesktopUpdate', []]);
        if (updaterState.status === 'ready') {
          updaterState = { status: 'installing', version: updaterState.version };
        }
        return updaterState;
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

test('settings backdrop dims the native Windows caption band', async () => {
  mount();
  const style = document.createElement('style');
  style.textContent = '.mixdog-settings-layer { background-color: rgba(0, 0, 0, .32); opacity: 1; }';
  document.head.appendChild(style);
  window.HTMLElement.prototype.getClientRects = () => [{ width: 1, height: 1 }];
  const topbar = document.createElement('header');
  topbar.className = 'topbar';
  topbar.style.backgroundColor = 'rgb(240, 240, 240)';
  document.body.prepend(topbar);
  document.documentElement.style.colorScheme = 'light';
  const titleBarDims = [];
  window.mixdogDesktop = {
    setTitleBarDim: async (dim) => { titleBarDims.push(dim); },
  };
  const { api } = capabilityApi();

  await renderSettings({ api });

  assert.ok(
    titleBarDims.some((dim) => dim?.color === '#a3a3a3'),
    `expected a scrim-composited caption color, received ${JSON.stringify(titleBarDims)}`,
  );
});

test('full-bleed settings replaces the native caption color instead of dimming it', async () => {
  mount();
  const style = document.createElement('style');
  style.textContent = `
    .mixdog-settings-layer { background-color: rgba(0, 0, 0, .32); opacity: 1; }
    .mixdog-settings__panel { background-color: rgb(255, 255, 255); }
  `;
  document.head.appendChild(style);
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 360 },
    innerHeight: { configurable: true, value: 600 },
  });
  window.HTMLElement.prototype.getClientRects = () => [{ width: 1, height: 1 }];
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.matches('.mixdog-settings')) {
      return { left: 0, top: 0, right: 360, bottom: 600, width: 360, height: 600 };
    }
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };
  const topbar = document.createElement('header');
  topbar.className = 'topbar';
  topbar.style.backgroundColor = 'rgb(240, 240, 240)';
  document.body.prepend(topbar);
  document.documentElement.style.colorScheme = 'light';
  const titleBarDims = [];
  window.mixdogDesktop = {
    setTitleBarDim: async (dim) => { titleBarDims.push(dim); },
  };
  const { api } = capabilityApi();

  await renderSettings({ api });

  assert.ok(
    titleBarDims.some((dim) => dim?.color === '#ffffff' && dim?.symbolColor === '#000000'),
    `expected the undimmed settings panel caption colors, received ${JSON.stringify(titleBarDims)}`,
  );
});

test('switching settings categories resets the shared pane scroll position', async () => {
  mount();
  const { api } = capabilityApi();
  await renderSettings({ api });
  const body = document.querySelector('.mixdog-settings__body');
  body.scrollTop = 240;
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Providers').click();
    await Promise.resolve();
  });
  assert.equal(body.scrollTop, 0);
});

test('Connection keeps a QR-sized loading shell until the pairing code is ready', async () => {
  mount();
  let resolveInfo;
  const pendingInfo = new Promise((resolve) => { resolveInfo = resolve; });
  const { api } = capabilityApi();
  api.getRemoteAccessInfo = () => pendingInfo;
  await renderSettings({ api });
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Connection').click();
    await Promise.resolve();
  });
  const loadingCard = document.querySelector('.settings-connection-card--loading');
  assert.equal(loadingCard?.getAttribute('aria-busy'), 'true');
  assert.ok(loadingCard?.querySelector('.settings-connection-qr-placeholder'));
  assert.equal(document.querySelector('.settings-connection-card svg'), null);

  await act(async () => {
    resolveInfo({
      port: 4317,
      urls: ['http://127.0.0.1:4317'],
      browserUrl: 'http://127.0.0.1:4317',
      appLink: 'mixdog://pair',
      apkUrl: 'http://127.0.0.1:4317/mixdog.apk',
      browserQrSvg: '<svg data-qr="lan-browser"></svg>',
      appQrSvg: '<svg data-qr="lan-app"></svg>',
      relayBrowserQrSvg: '<svg data-qr="relay-browser"></svg>',
      relayAppQrSvg: '<svg data-qr="relay-app"></svg>',
      apkQrSvg: '<svg data-qr="apk"></svg>',
    });
    await pendingInfo;
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.settings-connection-card--loading'), null);
  assert.ok(document.querySelector('svg[data-qr="relay-browser"]'));
});

test('Connection paints a preloaded QR immediately and reuses the cached request', async () => {
  mount();
  let calls = 0;
  const { api } = capabilityApi();
  api.getRemoteAccessInfo = async () => {
    calls += 1;
    return {
      port: 4317,
      urls: ['http://127.0.0.1:4317'],
      browserUrl: 'http://127.0.0.1:4317',
      appLink: 'mixdog://pair',
      apkUrl: 'http://127.0.0.1:4317/mixdog.apk',
      browserQrSvg: '<svg data-qr="lan-browser"></svg>',
      appQrSvg: '<svg data-qr="lan-app"></svg>',
      relayBrowserQrSvg: '<svg data-qr="relay-browser"></svg>',
      relayAppQrSvg: '<svg data-qr="relay-app"></svg>',
      apkQrSvg: '<svg data-qr="apk"></svg>',
    };
  };
  await preloadConnectionInfo(api);
  await renderSettings({ api });
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Connection').click();
    await Promise.resolve();
  });
  assert.equal(calls, 1);
  assert.equal(document.querySelector('.settings-connection-card--loading'), null);
  assert.ok(document.querySelector('svg[data-qr="relay-browser"]'));
});

test('SETTINGS_ITEMS is the exact TUI row registry and order', () => {
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.value), VALUES);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.label), LABELS);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.description), DESCRIPTIONS);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.kind), [
    'open', 'open', 'open', 'open', 'open', 'open', 'toggle', 'toggle', 'toggle', 'toggle',
    'static', 'toggle', 'open',
    'open', 'open', 'open', 'open', 'open', 'toggle', 'cycle', 'open', 'toggle', 'open',
  ]);
  for (const item of SETTINGS_ITEMS) {
    assert.deepEqual(Object.keys(item), ['value', 'label', 'description', 'kind']);
  }
});

test('background preload prepares every settings surface and opening reuses the shared cache', async () => {
  mount();
  const { api, readCalls } = capabilityApi();
  await preloadSettings(api);
  // Reads go out as several ordered chunks so each group paints as it lands;
  // the whole sweep still happens once.
  assert.ok(readCalls.length >= 1);
  const capabilities = readCalls.flat().map((request) => request.capability);
  assert.ok(capabilities.includes('getProfile'));
  assert.ok(capabilities.includes('getProviderSetup'));
  assert.ok(capabilities.includes('getChannelSetup'));
  // System shell stays TUI-only; the desktop neither preloads nor renders it.
  assert.ok(!capabilities.includes('getSystemShell'));

  const preloadCalls = readCalls.length;
  await renderSettings({ api });
  assert.equal(readCalls.length, preloadCalls, 'opening should reuse the background preload');
  assert.doesNotMatch(document.body.textContent, /Loading settings/);
  assert.equal(document.querySelector('input[name="title"]')?.value, 'Owner');
});

test('cold settings keep partial capability batches behind one spinner', async () => {
  mount();
  const { api } = capabilityApi();
  const read = api.readCapabilities;
  let releaseFirstBatch;
  const firstBatch = new Promise((resolve) => { releaseFirstBatch = resolve; });
  let blocked = true;
  api.readCapabilities = async (requests) => {
    if (blocked) {
      blocked = false;
      await firstBatch;
    }
    return read(requests);
  };
  await renderSettings({ api });
  const gate = document.querySelector('.mixdog-settings__category-stage .pane-surface-gate');
  assert.equal(gate?.dataset.ready, 'false');
  assert.ok(gate?.querySelector('.desktop-loading-spinner'));
  assert.equal(gate?.querySelector('.pane-surface-gate-content')?.getAttribute('aria-hidden'), 'true');

  await act(async () => {
    releaseFirstBatch();
    await firstBatch;
  });
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 400)));
  assert.equal(gate?.dataset.ready, 'true');
  assert.equal(document.querySelector('input[name="title"]')?.value, 'Owner');
});

test('cold command surfaces use the spinner shell and cache the completed body', async () => {
  mount();
  let resolveStatus;
  const statusPending = new Promise((resolve) => { resolveStatus = resolve; });
  let calls = 0;
  const api = {
    invokeCapability: async () => {
      calls += 1;
      return { value: await statusPending };
    },
    getSnapshot: async () => ({ items: [], queued: [] }),
  };
  await act(async () => {
    root.render(React.createElement(CommandSurface, { surface: 'context', api, onClose() {} }));
    await Promise.resolve();
  });
  const gate = document.querySelector('.command-surface .pane-surface-gate');
  assert.equal(gate?.dataset.ready, 'false');
  assert.ok(gate?.querySelector('.desktop-loading-spinner'));

  await act(async () => {
    resolveStatus({ used: 1, limit: 100 });
    await statusPending;
  });
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 400)));
  assert.equal(gate?.dataset.ready, 'true');
  await act(async () => root.render(React.createElement(CommandSurface, {
    surface: 'context', api, onClose() {},
  })));
  assert.equal(document.querySelector('.command-surface .pane-surface-gate')?.dataset.ready, 'true');
  assert.ok(calls >= 1);
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
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'), (node) => node.getAttribute('aria-label')),
    SETTINGS_CATEGORIES.map((item) => item.label),
  );
  // The rail is ONE flat list (user decision): no group headings at all, only
  // spacing between blocks.
  assert.equal(document.querySelector('.mixdog-settings__rail-group > h2'), null,
    'the settings rail renders without category headings');
  assert.deepEqual(SETTINGS_CATEGORIES.map((item) => item.label), [
    'General',
    'Context',
    'Providers',
    'Git',
    'Skills',
    'MCP',
    'Plugins',
    'Output style',
    'Channels',
    'Hooks',
    'System',
    'Shortcuts',
    'Connection',
    'About',
  ]);
  assert.equal(document.querySelectorAll('.mixdog-settings__rail button.active').length, 1);
  assert.equal(document.querySelector('.mixdog-settings__picker-list') === null, true,
    'selector .mixdog-settings__picker-list should be absent');
  assert.equal(document.querySelector('button[aria-label="Back to settings"]') === null, true,
    'selector button[aria-label="Back to settings"] should be absent');
  assert.ok(document.querySelector('input[name="title"]'));
  assert.match(document.querySelector('[aria-label="Theme"]')?.textContent || '', /Dark/);
  assert.ok(document.querySelector('input[aria-label="Web search"]'));
  assert.ok(document.querySelector('input[aria-label="Explorer"]'));
  assert.ok(document.querySelector('input[aria-label="Memory"]'));
  const generalRowTitles = Array.from(
    document.querySelectorAll('.mixdog-settings__row-title'),
    (node) => node.textContent,
  );
  assert.equal(generalRowTitles.at(-1), 'Side panels',
    'the desktop-local side-panel policy stays at the bottom of General');
  const sidePanels = document.querySelector('[aria-label="Side panels"]');
  assert.match(sidePanels?.textContent || '', /Both closed/);
  await act(async () => {
    sidePanels.click();
    await Promise.resolve();
  });
  const keepOpen = Array.from(document.querySelectorAll('.mx-menu [role="option"]'))
    .find((option) => option.textContent.includes('Keep open'));
  await act(async () => {
    keepOpen.click();
    await Promise.resolve();
  });
  assert.equal(window.localStorage.getItem('mixdog.desktop.side-panel-mode.v1'), 'keep-open');
  assert.equal(document.querySelector('.settings-theme-choice'), null);
  assert.equal(document.querySelector('input[aria-label="Auto-clear"]'), null,
    'session lifecycle toggles moved to the Context category');
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
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Context').click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector('input[aria-label="Auto-clear"]'));
  assert.ok(document.querySelector('input[aria-label="Auto-compact"]'));
  assert.deepEqual(
    Array.from(document.querySelectorAll('.mixdog-settings__row-title'), (node) => node.textContent)
      .filter((title) => title === 'Auto-compact' || title === 'Auto-clear'),
    ['Auto-compact', 'Auto-clear'],
  );
  assert.doesNotMatch(document.body.textContent, /Compaction strategy|Recall fast-track/);
  assert.match(document.body.textContent, /Core memories/);
  assert.equal(document.querySelector('input[aria-label="Memory"]'), null,
    'the Memory feature toggle lives in General, not Context');
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
  let categoryHost = null;
  const open = async (label) => {
    await act(async () => {
      Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
        .find((button) => button.textContent === label).click();
      await Promise.resolve();
    });
    const hosts = Array.from(document.querySelectorAll(
      '.mixdog-settings__category-stage .capability-settings-content',
    ));
    assert.equal(hosts.length, 1, `${label} must replace the outgoing category atomically`);
    if (categoryHost) {
      assert.equal(hosts[0], categoryHost,
        `${label} must update the retained category host instead of remounting it`);
    }
    categoryHost = hosts[0];
  };
  for (const [label, expected] of [
    ['Output style', /Minimal/],
    ['MCP', /No MCP servers configured/],
    ['Plugins', /Install plugin/],
    ['Hooks', /No hook rules configured/],
    ['Skills', /No skills found/],
    ['Context', /Core memories/],
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
  for (const category of ['Providers', 'Channels', 'MCP', 'Hooks']) {
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
      provider: 'discord',
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
    // Webhook endpoints and the relay ingress URL graduated to the main-pane
    // Webhooks page; settings keeps messaging wiring only.
    ['Channels', /Voice transcription.*Disable voice.*Telegram bot token/s],
    ['Context', /Core memories/],
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
});

test('OAuth controls auto-complete OpenAI and Grok while reserving manual code entry for Anthropic', async () => {
  mount();
  const calls = [];
  const run = async (capability, args = [], key = capability, refresh = true, silent = false) => {
    calls.push([capability, args, key, refresh, silent]);
    if (capability === 'beginOAuthProviderLogin') {
      const provider = String(args[0]);
      return {
        flowId: `oauth_${provider}`,
        provider,
        state: 'pending',
        manualUrl: 'https://example.test/manual',
        manualCodeSupported: true,
      };
    }
    if (capability === 'getOAuthProviderLoginStatus') {
      const provider = String(args[0]).slice('oauth_'.length);
      return {
        flowId: String(args[0]),
        provider,
        state: 'complete',
        completed: true,
        manualUrl: 'https://example.test/manual',
        manualCodeSupported: true,
      };
    }
    if (capability === 'completeOAuthProviderLogin') {
      return {
        flowId: String(args[0]),
        provider: 'anthropic-oauth',
        state: 'complete',
        completed: true,
        manualCodeSupported: true,
      };
    }
    if (capability === 'getProviderSetup') return {};
    return {};
  };

  for (const [id, label] of [['openai-oauth', 'OpenAI'], ['grok-oauth', 'Grok']]) {
    await act(async () => {
      root.render(React.createElement(OAuthControl, {
        key: id,
        provider: { id, label, authenticated: false },
        disabled: false,
        run,
      }));
      await Promise.resolve();
    });
    await act(async () => {
      document.querySelector('.settings-action').click();
      await Promise.resolve();
    });
    assert.ok(document.querySelector('.settings-oauth-dialog'));
    assert.equal(document.querySelector('.settings-oauth-code'), null);
    assert.equal(document.querySelector('.settings-oauth-url'), null);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(document.querySelector('.settings-oauth-dialog'), null);
    assert.ok(calls.some(([capability, args]) => capability === 'getOAuthProviderLoginStatus'
      && args[0] === `oauth_${id}`));
    assert.ok(calls.filter(([capability, args]) => capability === 'getOAuthProviderLoginStatus'
      && args[0] === `oauth_${id}`).every((call) => call[4] === true));
  }

  await act(async () => {
    root.render(React.createElement(OAuthControl, {
      key: 'anthropic-oauth',
      provider: { id: 'anthropic-oauth', label: 'Anthropic', authenticated: false },
      disabled: false,
      run,
    }));
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('.settings-action').click();
    await Promise.resolve();
  });
  assert.ok(document.querySelector('.settings-oauth-url'));
  const codeForm = document.querySelector('.settings-oauth-code');
  assert.ok(codeForm);
  codeForm.querySelector('input').value = 'code-123#state-456';
  await act(async () => {
    codeForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(calls.some(([capability, args]) => capability === 'completeOAuthProviderLogin'
    && args[1] === 'code-123#state-456'));
  assert.ok(calls.filter(([capability]) => capability === 'completeOAuthProviderLogin')
    .every((call) => call[4] === false));
  assert.equal(document.querySelector('.settings-oauth-dialog'), null);
});

test('selected output styles use Active status badges without internal metadata labels', async () => {
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
      provider: 'discord',
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
  const requestedSurface = () =>
    document.querySelector('.mixdog-settings__category-stage .capability-settings-content');
  await open('Providers');
  const providers = requestedSurface();
  assert.deepEqual(
    Array.from(providers.querySelectorAll('.settings-group > header h3'), (node) => node.textContent),
    ['OAuth providers', 'API-key providers', 'Local providers'],
  );
  assert.doesNotMatch(providers.textContent, /Save API key/);
  const providerRows = Array.from(providers.querySelectorAll('.settings-resource'));
  const connected = providerRows.find((row) => row.textContent.includes('OpenAI'));
  const disconnected = providerRows.find((row) => row.textContent.includes('Anthropic'));
  assert.equal(connected.querySelector('.settings-status')?.textContent, 'Connected');
  assert.ok(connected.querySelector('.settings-status--positive'));
  assert.equal(disconnected.querySelector('.settings-status')?.textContent, 'Not connected');
  assert.ok(disconnected.querySelector('.settings-status--neutral'));
  assert.equal(connected.querySelector('.settings-resource-control .settings-status') === null, true,
    'the connected resource control should not duplicate its status');
  assert.ok(disconnected.querySelector('input[aria-label="Anthropic API key"]'));
  const localForms = Array.from(providers.querySelectorAll('.settings-form-row'))
    .filter((row) => /endpoint/.test(row.textContent));
  assert.deepEqual(localForms.map((row) => row.querySelector('button')?.textContent), ['Save', 'Save']);
  const lmStudioEndpoint = providers.querySelector('input[aria-label="LM Studio endpoint"]');
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
  const mcp = requestedSurface();
  const server = Array.from(mcp.querySelectorAll('.settings-resource'))
    .find((row) => row.textContent.includes('docs'));
  assert.equal(server.querySelector('.settings-status')?.textContent, 'Connected');
  assert.equal(server.querySelector('.settings-resource-meta')?.textContent, '3 tools');
  assert.equal(server.querySelector('.settings-resource-control .settings-status') === null, true,
    'the server resource control should not duplicate its status');
  await open('Channels');
  const channels = requestedSurface();
  for (const title of ['Discord bot token', 'Telegram bot token']) {
    const form = channels.querySelector(`input[aria-label="${title}"]`).closest('.settings-form-row');
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
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Context').click();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('input[aria-label="Auto-compact"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(calls[0], ['setCompactionSettings', [{ auto: true }]]);
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'General').click();
    await Promise.resolve();
  });
  await act(async () => {
    document.querySelector('input[aria-label="Memory"]').click();
    await Promise.resolve();
  });
  assert.deepEqual(calls[1], ['setRecapEnabled', [false]]);

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
  assert.deepEqual(calls[2], ['setChannelProvider', ['telegram']]);
});

test('channel provider change surfaces restart guidance while the remote worker runs', async () => {
  mount();
  let toast;
  window.addEventListener('mixdog:desktop-toast', (event) => { toast = event.detail; }, { once: true });
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
  assert.deepEqual({ text: toast?.text, tone: toast?.tone }, {
    text: 'Channel set to Telegram. Restart remote to apply.',
    tone: 'info',
  });
  assert.equal(document.querySelector('.settings-notice'), null);
});

test('Context keeps the Auto-clear switch and provider idle windows inline', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getAutoClear: {
      enabled: true,
      idleMs: 3_600_000,
      providerDefaults: [{ provider: 'openai', idleMs: 600_000, builtInMs: 3_600_000, custom: true }],
    },
  });
  await renderSettings({ api });
  await act(async () => {
    Array.from(document.querySelectorAll('.mixdog-settings__rail button'))
      .find((button) => button.textContent === 'Context').click();
    await Promise.resolve();
  });
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
      provider: 'discord',
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
  // Relay tunnel replaced ngrok, and the ingress URL lives on the Webhooks
  // page — the settings Channels pane carries no webhook rows at all.
  assert.doesNotMatch(document.body.textContent, /Webhook ingress|Public webhook URL/);
  assert.doesNotMatch(document.body.textContent, /ngrok/);
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
    && args[0]?.provider === 'discord' && args[0]?.channelId === '222'));
});

test('General exposes the three desktop-local modes with persistent preference', async () => {
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
  assert.deepEqual(Array.from(document.querySelectorAll('.mx-menu[aria-label="Theme"] [role="option"]'),
    (node) => node.textContent.trim()), ['System', 'White', 'Dark']);
  const white = Array.from(document.querySelectorAll('.mx-menu[aria-label="Theme"] [role="option"]'))
    .find((entry) => entry.textContent.includes('White'));
  await act(async () => {
    white.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(calls.some(([capability]) => capability === 'setTheme'), false,
    'the desktop theme toggle stays local and never writes the engine/TUI theme');
  assert.equal(document.documentElement.dataset.mixdogTheme, 'light');
  assert.equal(window.localStorage.getItem('mixdog.desktop-theme-preference'), 'white');
});

// System shell moved back to TUI-only surface (user decision): the desktop
// hides the override entirely, so no editor test remains.

test('desktop update checks and installs through Electron updater without confirmation', async () => {
  mount();
  const { api, calls } = capabilityApi({
    getUpdateSettings: { currentVersion: '1.2.3', latestVersion: '1.2.4', updateAvailable: true },
    __updaterState: { status: 'ready', version: '1.2.4' },
  });
  await renderSettings({ api, initialSection: 'update' });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.ok(calls.some(([capability]) => capability === 'checkForDesktopUpdate'));
  assert.equal(calls.some(([capability]) => capability === 'checkForUpdate'), false);
  const update = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Update to'));
  await act(async () => { update.click(); await Promise.resolve(); });
  assert.ok(calls.some(([capability]) => capability === 'showDesktopUpdate'));
  assert.equal(calls.some(([capability]) => capability === 'runUpdateNow'), false);
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
    ['Providers', ['No OAuth providers available.', 'No API-key providers available.', 'No local providers available.']],
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
      .find((button) => button.textContent === 'Context').click();
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
  const usageApi = {
    invokeCapability: async ({ capability }) => {
      assert.equal(capability, 'getUsageDashboard');
      return { value: {
        total: { knownRemainingUsd: 5.15, providerCount: 4 },
        checkedAt: Date.now(),
        rows: [
          { id: 'ollama', label: 'Ollama', group: 'local', authenticated: true, sourceLabel: 'local', primary: 'local provider' },
          { id: 'openai', label: 'OpenAI API', group: 'api', authenticated: true, sourceLabel: 'API', remainingUsd: 5.15 },
          { id: 'openai-oauth', label: 'OpenAI OAuth', group: 'oauth', authenticated: true, sourceLabel: 'API window',
            windows: [{ label: '5H', usedPct: 17, source: 'provider-api' }] },
          { id: 'opencode-go', label: 'OpenCode Go API', group: 'api', authenticated: true, sourceLabel: 'opencode-go-console',
            windows: [{ label: 'WEEK', usedPct: 42, source: 'opencode-go-console' }] },
        ],
      } };
    },
  };
  await act(async () => {
    root.render(React.createElement(CommandSurface, {
      surface: 'usage',
      api: usageApi,
      onClose() {},
      onOpen() {},
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(
    Array.from(document.querySelectorAll('.usage-table thead th'), (cell) => cell.textContent),
    ['Provider', 'Type', 'Usage'],
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll('.usage-table tbody tr'), (row) => [
      row.querySelector('.usage-provider-cell b')?.textContent,
      row.querySelector('.usage-plan')?.textContent.trim(),
    ]),
    [['OpenAI', 'API'], ['OpenAI', 'Subscription'], ['OpenCode Go', 'Subscription']],
  );
  assert.equal(document.querySelector('.usage-summary'), null);
  assert.doesNotMatch(document.querySelector('.command-surface')?.textContent || '', /Provider quotas|Ollama|local provider|Refresh/);

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

test('Context command surface follows live state and coalesces status refreshes', async () => {
  mount();
  let stateListener = null;
  let unsubscribeCalls = 0;
  let contextCalls = 0;
  const statuses = [
    { usedTokens: 100, contextWindow: 1000, messages: { semantic: { chat: { tokens: 100 } } }, request: { toolSchemaBreakdown: {} } },
    { usedTokens: 200, contextWindow: 1000, messages: { semantic: { chat: { tokens: 200 } } }, request: { toolSchemaBreakdown: {} } },
    { usedTokens: 300, contextWindow: 1000, messages: { semantic: { chat: { tokens: 300 } } }, request: { toolSchemaBreakdown: {} } },
  ];
  const api = {
    invokeCapability: async ({ capability }) => {
      assert.equal(capability, 'contextStatus');
      const value = statuses[Math.min(contextCalls, statuses.length - 1)];
      contextCalls += 1;
      return { value };
    },
    getSnapshot: async () => ({ sessionId: 'context-live', contextWindow: 1000 }),
    subscribeState(listener) {
      stateListener = listener;
      return () => { unsubscribeCalls += 1; };
    },
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
    await Promise.resolve();
  });
  const messageTokens = () => Array.from(document.querySelectorAll('.context-mix-row'))
    .find((row) => row.querySelector('span')?.textContent === 'Messages')
    ?.querySelector('strong')?.textContent;
  assert.equal(contextCalls, 1);
  assert.equal(typeof stateListener, 'function');
  assert.match(document.querySelector('.context-surface-view')?.textContent || '', /10% used/);
  assert.equal(messageTokens(), '100');

  await act(async () => {
    stateListener({ sessionId: 'context-live', contextWindow: 1000, revision: 2 });
    stateListener({ sessionId: 'context-live', contextWindow: 1000, revision: 3 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(contextCalls, 3,
    'a live burst keeps one status request in flight and one latest refresh queued');
  assert.match(document.querySelector('.context-surface-view')?.textContent || '', /30% used/);
  assert.equal(messageTokens(), '300');

  await act(async () => root.render(null));
  assert.equal(unsubscribeCalls, 1, 'closing Context must release the live state subscription');
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
  assert.ok(document.querySelector('.mx-menu[role="listbox"]'));

  await act(async () => {
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.mx-menu[role="listbox"]') === null, true,
    'selector .mx-menu[role="listbox"] should be absent');
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

test('onboarding renders its first-run copy in the selected desktop language', async () => {
  mount();
  const { api } = capabilityApi();
  for (const language of ['ko', 'ja', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'it', 'pt-BR', 'ru', 'vi']) {
    const translate = i18next.getFixedT(language);
    assert.notEqual(translate('Make it yours'), 'Make it yours', `${language} onboarding title must be translated`);
    assert.notEqual(translate('Skip setup'), 'Skip setup', `${language} onboarding controls must be translated`);
  }
  await i18next.changeLanguage('ko');
  await act(async () => {
    root.render(React.createElement(OnboardingWizard, { api, onDone() {} }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('#onboarding-title')?.textContent, '나만의 Mixdog 만들기');
  assert.equal(document.querySelector('.onboarding-dialog > footer > button.secondary')?.textContent, '설정 건너뛰기');
  assert.equal(document.querySelector('.onboarding-profile-fields label span')?.textContent, '호칭');
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
  // Profile and Providers precede Models in the 11-step flow.
  await act(async () => next.click());
  const select = document.querySelector('button[role="combobox"][aria-label="Main model"]');
  await act(async () => select.click());
  assert.ok(document.querySelector('.mx-menu[role="listbox"]'));

  await act(async () => {
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.mx-menu[role="listbox"]') === null, true,
    'selector .mx-menu[role="listbox"] should be absent');
  assert.equal(document.querySelector('[role="alertdialog"]') === null, true,
    'selector [role="alertdialog"] should be absent');
  assert.equal(document.activeElement === select, true,
    'closing the confirmation should restore select focus');
});

test('settings ActionButton renders the flat grammar disabled and focus hooks', async () => {
  mount();
  const { ActionButton } = await import('./capability-controls.tsx');
  await act(async () => {
    root.render(React.createElement('div', null,
      React.createElement(ActionButton, { onClick() {} }, 'Connect'),
      React.createElement(ActionButton, { danger: true, disabled: true, onClick() {} }, 'Disconnect')));
    await Promise.resolve();
  });
  const [connect, disconnect] = Array.from(document.querySelectorAll('.settings-action'));
  // desktop.css owns the flat state matrix (renderer.test.mjs); here the
  // rendered controls must be reachable by the selectors that style it.
  assert.equal(disconnect.matches('.settings-action.danger:disabled'), true);
  assert.equal(connect.matches('.settings-action:not(:disabled)'), true);
  assert.equal(connect.matches('.settings-action.danger'), false);
  connect.focus();
  assert.equal(document.activeElement === connect, true,
    'the enabled action must be keyboard focusable so its focus ring can show');
  disconnect.focus();
  assert.equal(document.activeElement === disconnect, false,
    'a disabled action must not take focus');
});
