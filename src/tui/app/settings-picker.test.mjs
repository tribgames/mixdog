import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createSettingsPicker } from './settings-picker.mjs';

// The Settings panel against a fake snapshot: what each row shows, which
// writes ←/→ and Enter perform, and where Enter navigates. (The ownership /
// epoch rules of the same panel are pinned in panel-epoch.test.mjs.)

const SNAPSHOT = {
  autoClear: { enabled: true, idleMs: 60 * 60_000, provider: 'openai' },
  compaction: { auto: true },
  toolModules: { webSearch: { enabled: true }, memory: { enabled: false } },
  systemShell: { source: 'config', command: 'pwsh', effective: 'pwsh -NoLogo' },
  outputStyle: { current: { id: 'simple', label: 'Simple' } },
  webSearchRoute: { provider: 'openai', model: 'gpt-web' },
  profile: { title: 'Jay', languageEntry: { label: 'Korean' }, experienceLevelEntry: { label: 'Vibe coder' } },
  mcp: { connectedCount: 1, configuredCount: 2, failedCount: 1 },
  plugins: { count: 3 },
  skills: { count: 12 },
  updateSettings: { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true },
};

function createHarness(storeOverrides = {}) {
  supersedePanelEpoch();
  let live = null;
  const notices = [];
  const prompts = [];
  const opened = [];
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
    },
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  const opener = (name) => (options) => opened.push([name, options]);
  const store = {
    pushNotice: (message, tone) => notices.push([message, tone]),
    getSettingsSnapshot: async () => SNAPSHOT,
    getTheme: () => 'dusk',
    listThemes: () => [
      { id: 'dawn', label: 'Dawn' },
      { id: 'dusk', label: 'Dusk' },
    ],
    ...storeOverrides,
  };
  const { openSettingsPicker } = createSettingsPicker({
    store,
    state: { model: 'gpt-5', provider: 'openai', workflow: { id: 'default' } },
    surface,
    setProviderPrompt: () => {},
    setSettingsPrompt: (prompt) => prompts.push(prompt),
    settingsHeavyCacheRef: { current: null },
    settingsRequestRef: { current: 0 },
    formatDuration: (ms) => `${Math.round(ms / 60_000)}m`,
    displayModelName: (model, provider) => `${model}@${provider}`,
    routeModelLabel: (route) => (route ? `${route.model}@${route.provider}` : '(unset)'),
    workflowDisplayName: (workflow) => `WF:${workflow.id}`,
    workflowSwitchNotice: (result) => `workflow → ${result.id}`,
    themeNotice: (applied) => `theme → ${applied.id}`,
    openModelPicker: opener('model'),
    openWebSearchPicker: opener('websearch'),
    openAgentsPicker: opener('agents'),
    openWorkflowPicker: opener('workflow'),
    openOutputStylePicker: opener('output-style'),
    openProviderSetupPicker: opener('providers'),
    openThemePicker: opener('theme'),
    openAutoClearPicker: opener('autoclear'),
    openProfilePicker: opener('profile'),
    openMcpPicker: opener('mcp'),
    openPluginsPicker: opener('plugins'),
    openSkillsPicker: opener('skills'),
    openMemoryCorePicker: opener('memory'),
    openUpdatePicker: opener('update'),
    openDeveloperPicker: opener('developer'),
  });
  const current = () => live;
  const row = (value) => current().items.find((item) => item.value === value);
  return { openSettingsPicker, current, row, notices, prompts, opened };
}

test('rows render the snapshot values in the parity order', async () => {
  const h = createHarness();
  await h.openSettingsPicker();
  const panel = h.current();
  assert.equal(panel.title, 'Settings');
  // Voice reads the real managed-runtime config, so only its shape is pinned.
  assert.match(h.row('voice').meta, /^(On|Off)$/);
  assert.deepEqual(
    panel.items.map((item) => [item.value, item.value === 'voice' ? 'Off' : (item.meta ?? null)]),
    [
      ['model', 'gpt-5@openai'],
      ['websearch', 'gpt-web@openai'],
      ['workflow', 'WF:default'],
      ['output-style', 'Simple'],
      ['profile', 'Jay · Vibe coder · Korean'],
      ['theme', 'Dusk'],
      ['web-search-enabled', 'On'],
      ['memory-enabled', 'Off'],
      ['autocompact', 'On'],
      ['autoclear', 'On (60m)'],
      ['memory', null],
      ['providers', null],
      ['mcp', null],
      ['plugins', null],
      ['skills', null],
      ['voice', 'Off'],
      ['system-shell', 'pwsh'],
      ['developer', null],
      ['update', '1.0.0 → 1.1.0'],
    ]
  );
  assert.equal(h.row('mcp').description, '1/2 connected · 1 failed');
  assert.equal(h.row('plugins').description, '3 detected');
  assert.equal(h.row('skills').description, '12 available');
  assert.equal(h.row('autoclear').description, 'Clear idle sessions after 60m (openai default). Enter for options.');
  assert.equal(h.row('system-shell').description, 'Effective command: pwsh -NoLogo');
});

test('←/→ toggles write through the store and refresh the panel', async () => {
  const writes = [];
  const h = createHarness({
    setAutoClear: async (patch) => {
      writes.push(['autoClear', patch]);
      return { enabled: false };
    },
    setCompactionSettings: async (patch) => {
      writes.push(['compaction', patch]);
      return { auto: false };
    },
    setWebSearchEnabled: async (enabled) => {
      writes.push(['webSearch', enabled]);
      return true;
    },
    setMemoryToolsEnabled: async (enabled) => {
      writes.push(['memory', enabled]);
      return true;
    },
  });
  await h.openSettingsPicker();
  h.current().onLeft(h.row('autoclear'));
  h.current().onRight(h.row('autocompact'));
  h.current().onSelect('web-search-enabled', h.row('web-search-enabled'));
  h.current().onLeft(h.row('memory-enabled'));
  await flush();
  assert.deepEqual(writes, [
    ['autoClear', { enabled: false }],
    ['compaction', { auto: false }],
    ['webSearch', false],
    ['memory', true],
  ]);
  assert.deepEqual(
    h.notices.map(([message]) => message),
    ['Auto-clear off', 'Compaction auto off', 'Web search off · new sessions', 'Memory on · new sessions']
  );
  assert.equal(h.current().title, 'Settings', 'the post-write refresh repainted Settings');
});

test('←/→ on Output style / Workflow / Theme cycle with wrap-around', async () => {
  const writes = [];
  const h = createHarness({
    listOutputStyles: async () => ({ current: { id: 'simple' }, styles: [{ id: 'default' }, { id: 'simple' }] }),
    setOutputStyle: async (id) => {
      writes.push(['style', id]);
      return { id };
    },
    listWorkflows: async () => [{ id: 'default', active: true }, { id: 'review' }],
    setWorkflow: async (id) => {
      writes.push(['workflow', id]);
      return { id };
    },
    setTheme: (id) => {
      writes.push(['theme', id]);
      return { id };
    },
  });
  await h.openSettingsPicker();
  h.current().onRight(h.row('output-style'));
  await flush();
  h.current().onLeft(h.row('workflow'));
  await flush();
  h.current().onRight(h.row('theme'));
  await flush();
  assert.deepEqual(writes, [
    ['style', 'default'],
    ['workflow', 'review'],
    ['theme', 'dawn'],
  ]);
  assert.deepEqual(
    h.notices.map(([message]) => message),
    ['Output style set to Default.', 'workflow → review', 'theme → dawn']
  );
});

test('Enter routes to the owning picker with a Settings return, or opens the shell prompt', async () => {
  const h = createHarness();
  await h.openSettingsPicker();
  for (const value of [
    'model',
    'websearch',
    'workflow',
    'output-style',
    'profile',
    'theme',
    'autoclear',
    'providers',
    'mcp',
    'plugins',
    'skills',
    'memory',
    'developer',
    'update',
  ]) {
    h.current().onSelect(value, h.row(value));
  }
  assert.deepEqual(
    h.opened.map(([name]) => name),
    [
      'model',
      'websearch',
      'workflow',
      'output-style',
      'profile',
      'theme',
      'autoclear',
      'providers',
      'mcp',
      'plugins',
      'skills',
      'memory',
      'developer',
      'update',
    ]
  );
  assert.equal(typeof h.opened.find(([name]) => name === 'developer')[1].returnTo, 'function');
  const modelOptions = h.opened.find(([name]) => name === 'model')[1];
  assert.equal(modelOptions.returnLabel, 'Settings');
  assert.equal(modelOptions.returnOnNestedCancel, true);
  assert.equal(modelOptions.handoffPanel.description, 'Switching model...');
  assert.equal(typeof modelOptions.returnTo, 'function');
  assert.equal(h.opened.find(([name]) => name === 'providers')[1].continueLabel, 'Back to settings');

  h.current().onSelect('system-shell', h.row('system-shell'));
  assert.equal(h.current(), null);
  assert.equal(h.prompts.at(-1).kind, 'system-shell');
  assert.equal(h.prompts.at(-1).initialValue, 'pwsh');
});

test('a failed snapshot surfaces as a notice, never a rejection', async () => {
  const h = createHarness({
    getSettingsSnapshot: async () => {
      throw new Error('daemon away');
    },
  });
  await h.openSettingsPicker();
  assert.deepEqual(h.notices, [['settings unavailable: daemon away', 'error']]);
});
