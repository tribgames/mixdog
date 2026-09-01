import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelPicker } from './model-picker.mjs';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createRoutePickers } from './route-pickers.mjs';
import { createSettingsPicker } from './settings-picker.mjs';
import { createSlashDispatch } from './slash-dispatch.mjs';
import { createThemeEffortPickers } from './theme-effort-pickers.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
};

function createPanelHost() {
  let current = null;
  const painted = [];
  const setPicker = (next) => {
    const previous = current;
    current = typeof next === 'function' ? next(previous) : next;
    if (shouldSupersedePanelEpoch(previous, current)) supersedePanelEpoch();
    painted.push(current);
  };
  const surface = createPanelSurface({
    setPicker,
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  return { current: () => current, painted, setPicker, surface };
}

const HANDOFF = {
  title: 'Settings',
  description: 'Applying selection...',
  help: 'Esc Close',
  indexMode: 'never',
  pickerKey: 'settings-handoff',
  loading: true,
  items: [],
};

function settingsDeps(host, store, opened = {}) {
  const noop = () => {};
  return {
    store: { pushNotice: noop, ...store },
    state: { model: 'gpt-5', provider: 'openai', workflow: { id: 'default' } },
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    settingsHeavyCacheRef: { current: null },
    settingsRequestRef: { current: 0 },
    formatDuration: (ms) => `${ms}ms`,
    displayModelName: () => 'GPT-5',
    routeModelLabel: () => '(unset)',
    workflowDisplayName: () => 'Default',
    workflowSwitchNotice: () => 'workflow switched',
    themeNotice: () => 'theme set',
    openModelPicker: (options) => { opened.model = options; },
    openWebSearchPicker: noop,
    openAgentsPicker: noop,
    openWorkflowPicker: (options) => { opened.workflow = options; },
    openOutputStylePicker: (options) => { opened.outputStyle = options; },
    openProviderSetupPicker: noop,
    openThemePicker: (options) => { opened.theme = options; },
    openAutoClearPicker: noop,
    openProfilePicker: noop,
    openMcpPicker: noop,
    openPluginsPicker: noop,
    openSkillsPicker: noop,
    openMemoryCorePicker: noop,
    openUpdatePicker: noop,
  };
}

test('Settings paints its loading destination before the daemon snapshot settles', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Theme' });
  const snapshotGate = deferred();
  const opened = {};
  const { openSettingsPicker } = createSettingsPicker(settingsDeps(
    host,
    { getSettingsSnapshot: () => snapshotGate.promise },
    opened,
  ));

  const opening = openSettingsPicker();
  assert.equal(host.current()?.title, 'Settings');
  assert.match(host.current()?.description || '', /Loading settings/i);
  assert.notEqual(host.current(), null);

  snapshotGate.resolve({});
  await opening;
  const settings = host.current();
  assert.equal(settings?.title, 'Settings');
  assert.ok(settings.items.length > 0);

  for (const action of ['model', 'workflow', 'output-style', 'theme']) {
    const item = settings.items.find((entry) => entry._action === action);
    settings.onSelect(item.value, item);
  }
  for (const options of [opened.model, opened.workflow, opened.outputStyle, opened.theme]) {
    assert.equal(options?.handoffPanel?.title, 'Settings');
    assert.equal(options?.handoffPanel?.pickerKey, 'settings-handoff');
    assert.equal(options?.handoffPanel?.loading, true);
  }
});

test('Model save keeps a Settings handoff panel visible until the write settles', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const saveGate = deferred();
  const { openModelPicker } = createModelPicker({
    store: {
      pushNotice: () => {},
      listProviderModels: async () => [],
      setRoute: () => saveGate.promise,
    },
    getState: () => ({ provider: 'openai', model: 'gpt-5', effort: null, fast: false }),
    surface: host.surface,
    setProviderPrompt: () => {},
    setSettingsPrompt: () => {},
    providerModelsCacheRef: {
      current: {
        at: Date.now(),
        models: [{ provider: 'openai', id: 'gpt-5', display: 'GPT-5' }],
      },
    },
    webSearchModelsCacheRef: { current: { models: [], at: 0 } },
    modelPickerRequestRef: { current: 0 },
    clearModelCaches: () => {},
    modelSwitchNotice: () => 'switched',
    openProviderSetupPicker: () => {},
  });

  await openModelPicker({
    handoffPanel: HANDOFF,
    onAfterSelect: () => host.setPicker({ title: 'Settings', items: [{ value: 'done' }] }),
  });
  const providers = host.current();
  providers.onSelect(providers.items[0].value, providers.items[0]);
  const models = host.current();
  models.onSelect(models.items[0].value, models.items[0]);

  assert.equal(host.current(), HANDOFF);
  assert.equal(host.painted.at(-1), HANDOFF);

  saveGate.resolve(true);
  await flush();
  assert.equal(host.current()?.title, 'Settings');
  assert.notEqual(host.current(), HANDOFF);
});

function routePicker(host, store) {
  return createRoutePickers({
    store: { pushNotice: () => {}, ...store },
    state: {},
    surface: host.surface,
    setProviderPrompt: () => {},
    setSettingsPrompt: () => {},
    closeUsagePanel: () => {},
    clean: (value) => value,
    routeLabel: () => 'route',
    agentModelParts: () => [],
    agentModelProfile: () => 'profile',
    workflowSwitchNotice: () => 'workflow switched',
    openModelPicker: () => {},
  });
}

test('Workflow and output-style saves keep the Settings handoff visible until their writes settle', async () => {
  supersedePanelEpoch();
  const workflowHost = createPanelHost();
  const workflowGate = deferred();
  const workflow = routePicker(workflowHost, {
    listWorkflows: async () => [{ id: 'solo', name: 'Solo', active: true }],
    setWorkflow: () => workflowGate.promise,
  });
  await workflow.openWorkflowPicker({
    returnTo: () => workflowHost.setPicker({ title: 'Settings', items: [{ value: 'done' }] }),
    handoffPanel: HANDOFF,
  });
  const workflowPanel = workflowHost.current();
  workflowPanel.onSelect(workflowPanel.items[0].value, workflowPanel.items[0]);
  assert.equal(workflowHost.current(), HANDOFF);

  workflowGate.resolve({ id: 'solo' });
  await flush();
  assert.equal(workflowHost.current()?.title, 'Settings');

  const styleHost = createPanelHost();
  const styleGate = deferred();
  const outputStyle = routePicker(styleHost, {
    listOutputStyles: async () => ({
      current: { id: 'simple' },
      styles: [{ id: 'simple', label: 'Simple' }],
    }),
    setOutputStyle: () => styleGate.promise,
  });
  await outputStyle.openOutputStylePicker({
    returnTo: () => styleHost.setPicker({ title: 'Settings', items: [{ value: 'done' }] }),
    handoffPanel: HANDOFF,
  });
  const stylePanel = styleHost.current();
  stylePanel.onSelect(stylePanel.items[0].value, stylePanel.items[0]);
  assert.equal(styleHost.current(), HANDOFF);

  styleGate.resolve({ current: { id: 'simple', label: 'Simple' } });
  await flush();
  assert.equal(styleHost.current()?.title, 'Settings');
});

test('Theme selection hands directly to Settings without a null panel', () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const { openThemePicker } = createThemeEffortPickers({
    state: {},
    store: {
      listThemes: () => [{ id: 'basic', label: 'Basic' }],
      getTheme: () => 'basic',
      setTheme: (id) => ({ id, label: 'Basic' }),
      pushNotice: () => {},
    },
    surface: host.surface,
    setProviderPrompt: () => {},
    setSettingsPrompt: () => {},
    closeUsagePanel: () => {},
    clean: (value) => value,
  });

  openThemePicker({
    returnTo: () => host.setPicker({ title: 'Settings', items: [{ value: 'done' }] }),
    handoffPanel: HANDOFF,
  });
  const theme = host.current();
  const paintedBefore = host.painted.length;
  theme.onSelect(theme.items[0].value, theme.items[0]);

  const transitionPaints = host.painted.slice(paintedBefore);
  assert.deepEqual(transitionPaints.map((panel) => panel?.title), ['Settings', 'Settings']);
  assert.ok(transitionPaints.every(Boolean));
});

function workflowSlashDispatch(host, openWorkflowPicker, notices = []) {
  return createSlashDispatch({
    state: { busy: false, commandBusy: false },
    store: { pushNotice: (message, tone) => notices.push([message, tone]) },
    normalizeSlashCommandName: (value) => value,
    surface: host.surface,
    closeUsagePanel: () => {},
    openWorkflowPicker,
  });
}

test('slash option entry keeps a loading panel until the async picker paints', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const openGate = deferred();
  const { runSlashCommand } = workflowSlashDispatch(host, () => {
    const own = host.surface.claim();
    return openGate.promise.then(() => own.paint({
      title: 'Workflow',
      description: 'Select active workflow.',
      items: [{ value: 'solo', label: 'Solo' }],
    }));
  });

  assert.equal(runSlashCommand('workflow'), true);
  assert.equal(host.current()?._kind, 'slash-loading:workflow');
  assert.equal(host.current()?.title, 'Workflow');
  assert.equal(host.current()?.loading, true);

  openGate.resolve();
  await flush();
  assert.equal(host.current()?.title, 'Workflow');
  assert.equal(host.current()?._kind, undefined);
  assert.ok(host.current()?.items.length > 0);
});

test('Esc on slash loading prevents the pending picker from appearing later', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const openGate = deferred();
  const { runSlashCommand } = workflowSlashDispatch(host, () => {
    const own = host.surface.claim();
    return openGate.promise.then(() => own.paint({
      title: 'Workflow',
      items: [{ value: 'solo', label: 'Solo' }],
    }));
  });

  runSlashCommand('workflow');
  const loading = host.current();
  assert.equal(loading?._kind, 'slash-loading:workflow');
  loading.onCancel();
  assert.equal(host.current(), null);

  openGate.resolve();
  await flush();
  assert.equal(host.current(), null);
});
