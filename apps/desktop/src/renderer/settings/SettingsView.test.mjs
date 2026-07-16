import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

register(new URL('./test-css-loader.mjs', import.meta.url));
const { SettingsView } = await import('./SettingsView.tsx');
const { SETTINGS_ITEMS } = await import('./settings-items.ts');

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
  'search', 'providers', 'mcp', 'plugins', 'hooks', 'skills', 'update',
];
const LABELS = [
  'Profile', 'Auto-clear', 'Auto-compact', 'Compact type', 'Channels enabled', 'Remote Runtime',
  'Channel', 'Setting', 'Output style', 'Theme', 'Workflow', 'Model', 'Search model', 'Providers',
  'MCP servers', 'Plugins', 'Hooks', 'Skills', 'Update',
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
    getUpdateSettings: { currentVersion: '1.2.3', autoUpdate: false },
    getUpdateStatus: { phase: 'idle' },
    ...overrides,
  };
  const calls = [];
  return {
    calls,
    api: {
      invokeCapability: async ({ capability, args = [] }) => {
        if (/^(set|toggle|check|run|save)/.test(capability)) calls.push([capability, args]);
        return { value: values[capability] ?? { ok: true }, snapshot: { items: [], queued: [] } };
      },
      listProviderModels: async () => [],
      getSnapshot: async () => ({ items: [], queued: [] }),
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

test('SETTINGS_ITEMS is the exact TUI row registry and order', () => {
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.value), VALUES);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.label), LABELS);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.description), DESCRIPTIONS);
  assert.deepEqual(SETTINGS_ITEMS.map((item) => item.kind), [
    'open', 'toggle', 'toggle', 'static', 'toggle', 'toggle', 'cycle', 'open', 'open',
    'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open',
  ]);
  for (const item of SETTINGS_ITEMS) {
    assert.deepEqual(Object.keys(item), ['value', 'label', 'description', 'kind']);
  }
});

test('settings renders exactly the 19 TUI rows and no removed sections or voice exposure', async () => {
  mount();
  const { api } = capabilityApi();
  await renderSettings({ api });
  assert.deepEqual(
    Array.from(document.querySelectorAll('.mixdog-settings__picker-row .mixdog-settings__row-title'), (node) => node.textContent),
    SETTINGS_ITEMS.map((item) => item.label),
  );
  assert.equal(document.querySelectorAll('.mixdog-settings__picker-row').length, 19);
  assert.doesNotMatch(document.body.textContent, /Agents|Memory settings|Schedules & Webhooks|Diagnostics|Voice transcription/);
  assert.match(document.body.textContent, /Fast-track \(fixed\)/);
  assert.match(document.body.textContent, /1\/1 connected/);
});

test('settings command can open the TUI-equivalent root picker', async () => {
  mount();
  const { api } = capabilityApi();
  await renderSettings({ api, initialSection: null });
  assert.equal(document.querySelectorAll('.mixdog-settings__picker-row').length, SETTINGS_ITEMS.length);
  assert.equal(document.querySelector('button[aria-label="Back to settings"]'), null);
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

  const channel = document.querySelector('button[aria-label="Channel"]');
  await act(async () => channel.click());
  const telegram = Array.from(document.querySelectorAll('[role="option"]'))
    .find((entry) => entry.textContent.trim() === 'Telegram');
  await act(async () => { telegram.click(); await Promise.resolve(); });
  assert.deepEqual(calls[1], ['setBackend', ['telegram']]);
});

test('Auto-clear duration and inline notices match TUI formatting and channel restart guidance', async () => {
  mount();
  const { api } = capabilityApi({
    getAutoClear: { enabled: true, idleMs: 5_400_000, provider: 'default', providerDefaults: [] },
    isRemoteEnabled: true,
    getChannelWorkerStatus: { running: true, pid: 42 },
  });
  await renderSettings({ api });
  assert.match(document.body.textContent, /On \(1h 30m 0s\)/);
  assert.match(document.body.textContent, /Clear idle sessions after 1h 30m 0s/);
  const channel = document.querySelector('button[aria-label="Channel"]');
  await act(async () => channel.click());
  const telegram = Array.from(document.querySelectorAll('[role="option"]'))
    .find((entry) => entry.textContent.trim() === 'Telegram');
  await act(async () => { telegram.click(); await Promise.resolve(); await Promise.resolve(); });
  assert.match(document.querySelector('[role="status"]')?.textContent || '', /Channel set to Telegram\. Restart remote to apply\./);
});

test('Auto-clear opens advanced options while its switch remains inline', async () => {
  mount();
  const { api } = capabilityApi({
    getAutoClear: {
      enabled: true,
      idleMs: 3_600_000,
      providerDefaults: [{ provider: 'openai', idleMs: 600_000, builtInMs: 3_600_000, custom: true }],
    },
  });
  await renderSettings({ api });
  await act(async () => {
    document.querySelector('button[aria-label="Open Auto-clear options"]').click();
    await Promise.resolve();
  });
  assert.match(document.body.textContent, /Provider default idle windows/);
  assert.ok(document.querySelector('input[aria-label="Auto-clear"]'));
  assert.ok(document.querySelector('input[name="duration"]'));
  assert.ok(document.querySelector('button[aria-label="Back to settings"]'));
});

test('channel Setting mirrors Discord and Telegram token/target pickers without voice or webhook controls', async () => {
  mount();
  const { api } = capabilityApi();
  await renderSettings({ api, initialSection: 'channel-setting' });
  assert.match(document.body.textContent, /Discord/);
  assert.match(document.body.textContent, /Telegram/);
  assert.match(document.body.textContent, /Bot token/);
  assert.match(document.body.textContent, /Main channel/);
  assert.match(document.body.textContent, /Main chat/);
  assert.doesNotMatch(document.body.textContent, /Voice|Webhook|ngrok|Schedules/);
});

test('theme previews without persistence and restores the opening theme on Back', async () => {
  mount();
  const { api, calls } = capabilityApi({
    listThemes: [{ id: 'basic', label: 'Basic' }, { id: 'light', label: 'Light' }],
    getTheme: 'basic',
  });
  await renderSettings({ api, initialSection: 'theme' });
  const light = Array.from(document.querySelectorAll('.settings-resource'))
    .find((entry) => entry.textContent.includes('Light'));
  await act(async () => {
    light.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    await Promise.resolve();
  });
  assert.ok(calls.some(([capability, args]) => capability === 'setTheme' && args[0] === 'light' && args[1]?.persist === false));
  await act(async () => {
    document.querySelector('button[aria-label="Back to settings"]').click();
    await Promise.resolve();
  });
  assert.ok(calls.some(([capability, args]) => capability === 'setTheme' && args[0] === 'basic' && args[1]?.persist === false));
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
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
});

test('plugins expose MCP enable only for script-backed MCP', async () => {
  mount();
  const { api } = capabilityApi({
    pluginsStatus: {
      count: 2,
      plugins: [
        { id: 'inline', name: 'Inline', mcpInline: true },
        { id: 'script', name: 'Script', mcpScript: 'scripts/run-mcp.mjs' },
      ],
    },
  });
  await renderSettings({ api, initialSection: 'plugins' });
  const pluginRows = Array.from(document.querySelectorAll('.settings-resource'));
  assert.doesNotMatch(pluginRows.find((row) => row.textContent.includes('Inline')).textContent, /Enable MCP/);
  assert.match(pluginRows.find((row) => row.textContent.includes('Script')).textContent, /Enable MCP/);
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
  assert.equal(document.activeElement, before);
});
