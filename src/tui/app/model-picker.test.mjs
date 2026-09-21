import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createModelPicker } from './model-picker.mjs';

// The Model picker's per-provider model list: the effort / Fast / context /
// thinking selections a row carries, what the footer shows for them, and the
// route the Enter key saves.

const EFFORTS = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

const MODELS = [
  {
    provider: 'anthropic',
    id: 'claude-x-1',
    display: 'Claude X',
    effortOptions: EFFORTS,
    fastCapable: true,
    fastEfforts: ['low', 'medium'],
    contextWindow: 200_000,
    maxContextWindow: 1_000_000,
    modelParameterOptions: [
      {
        id: 'thinking',
        label: 'Thinking',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ],
      },
    ],
    defaultModelParameters: { thinking: 'off' },
  },
  { provider: 'anthropic', id: 'claude-plain', display: 'Claude Plain', contextWindow: 100_000 },
];

function createHarness({ state = {}, store: overrides = {}, models = MODELS } = {}) {
  supersedePanelEpoch();
  let live = null;
  const notices = [];
  const routes = [];
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
    },
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  const providerModelsCacheRef = { current: { models, at: Date.now() } };
  const { openModelPicker } = createModelPicker({
    store: {
      pushNotice: (message, tone) => notices.push([message, tone]),
      listProviderModels: async () => models,
      setRoute: async (route) => {
        routes.push(route);
        return true;
      },
      ...overrides,
    },
    getState: () => ({ provider: 'anthropic', model: 'claude-x-1', effort: null, fast: false, ...state }),
    surface,
    setProviderPrompt: () => {},
    setSettingsPrompt: () => {},
    providerModelsCacheRef,
    webSearchModelsCacheRef: { current: { models: [], at: 0 } },
    modelPickerRequestRef: { current: 0 },
    modelSwitchNotice: () => 'switched',
    openProviderSetupPicker: () => {},
  });
  const current = () => live;
  const row = (id) => current().items.find((item) => item._modelId === id);
  const footerText = (id) =>
    current()
      .footer(row(id))
      .map((line) => line.text);
  const openProvider = async (options = {}) => {
    await openModelPicker(options);
    const providers = current();
    providers.onSelect(providers.items[0].value, providers.items[0]);
  };
  return { openModelPicker, openProvider, current, row, footerText, notices, routes, providerModelsCacheRef };
}

test('model list footer: default effort, context, Fast and thinking lines', async () => {
  const h = createHarness();
  await h.openProvider();
  assert.equal(h.current().pickerKey, 'model-picker:provider-models:anthropic');
  // Fast is not offered at the default (high) effort, so no Fast line yet.
  assert.deepEqual(h.footerText('claude-x-1'), [
    'High Effort ←/→ To Adjust',
    '20% · 200k Context · Default · C/Shift+C Adjust',
    'Thinking: Off · T Toggle',
  ]);
  // No effort/Fast/parameters: only the context line remains.
  assert.deepEqual(h.footerText('claude-plain'), ['100% · 100k Context · Default · C/Shift+C Adjust']);
  assert.equal(h.row('claude-x-1').marker, '✓');
});

test('←/→ cycle effort with wrap-around and Fast follows the effort it is allowed on', async () => {
  const h = createHarness();
  await h.openProvider();
  const model = h.row('claude-x-1');
  h.current().onRight(model);
  assert.equal(h.footerText('claude-x-1')[0], 'Low Effort ←/→ To Adjust', 'wraps past high');
  h.current().onLeft(h.row('claude-x-1'));
  h.current().onLeft(h.row('claude-x-1'));
  assert.equal(h.footerText('claude-x-1')[0], 'Medium Effort ←/→ To Adjust');
  h.current().onTab(h.row('claude-x-1'));
  assert.equal(h.footerText('claude-x-1')[2], 'Fast On · Tab Toggle');
  h.current().onRight(h.row('claude-x-1'));
  assert.equal(h.footerText('claude-x-1')[0], 'High Effort ←/→ To Adjust');
  assert.equal(h.footerText('claude-x-1').length, 3, 'Fast is unavailable at high');
});

test('C/Shift+C step the context in 10% notches and T cycles thinking', async () => {
  const h = createHarness();
  await h.openProvider();
  h.current().onKey('c', {}, h.row('claude-x-1'));
  h.current().onKey('c', {}, h.row('claude-x-1'));
  assert.equal(h.footerText('claude-x-1')[1], '40% · 400k Context · C/Shift+C Adjust');
  h.current().onKey('C', {}, h.row('claude-x-1'));
  assert.equal(h.footerText('claude-x-1')[1], '30% · 300k Context · C/Shift+C Adjust');
  h.current().onKey('t', {}, h.row('claude-x-1'));
  assert.equal(h.footerText('claude-x-1')[2], 'Thinking: On · T Toggle');
  h.current().onKey('t', {}, h.row('claude-plain'));
  assert.deepEqual(h.footerText('claude-plain'), ['100% · 100k Context · Default · C/Shift+C Adjust']);
});

test('Enter saves the selected route through store.setRoute and hands the surface back', async () => {
  const h = createHarness();
  const after = [];
  await h.openProvider({ onAfterSelect: () => after.push('back') });
  h.current().onRight(h.row('claude-x-1'));
  h.current().onTab(h.row('claude-x-1'));
  h.current().onKey('c', {}, h.row('claude-x-1'));
  h.current().onSelect(h.row('claude-x-1').value, h.row('claude-x-1'));
  await flush();
  assert.deepEqual(h.routes, [
    {
      provider: 'anthropic',
      model: 'claude-x-1',
      effort: 'low',
      contextPercent: 30,
      fast: true,
      modelParameters: { thinking: 'off' },
    },
  ]);
  assert.deepEqual(after, ['back']);
  assert.deepEqual(h.notices.at(-1), ['switched', 'info']);
  assert.equal(h.providerModelsCacheRef.current.at, 0, 'catalog marked stale after a save');

  await h.openProvider();
  h.current().onSelect(h.row('claude-plain').value, h.row('claude-plain'));
  await flush();
  assert.deepEqual(h.routes.at(-1), { provider: 'anthropic', model: 'claude-plain', contextPercent: 100 });
});

test('a caller-owned save goes through onSelectRoute and reports its failure', async () => {
  const h = createHarness();
  const saved = [];
  await h.openProvider({
    onSelectRoute: async (route, model, effort) => {
      saved.push([route.model, model.id, effort]);
      throw new Error('disk full');
    },
    currentRoute: { provider: 'anthropic', model: 'claude-x-1', effort: 'medium', fast: true },
  });
  assert.equal(h.footerText('claude-x-1')[0], 'Medium Effort ←/→ To Adjust', 'currentRoute seeds the effort');
  assert.equal(h.footerText('claude-x-1')[2], 'Fast On · Tab Toggle');
  h.current().onSelect(h.row('claude-x-1').value, h.row('claude-x-1'));
  await flush();
  assert.deepEqual(saved, [['claude-x-1', 'claude-x-1', 'medium']]);
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.notices.at(-1), ['Couldn’t save model: disk full', 'error']);
});

test('Esc on the model list returns to the provider list, or to the caller when nested', async () => {
  const h = createHarness();
  await h.openProvider();
  h.current().onCancel();
  assert.equal(h.current().pickerKey, 'model-picker:providers:anthropic');

  const returned = [];
  const g = createHarness();
  await g.openProvider({ returnTo: () => returned.push(1), returnOnNestedCancel: true, returnLabel: 'Agents' });
  assert.match(g.current().help, /Esc Agents$/);
  g.current().onCancel();
  assert.deepEqual(returned, [1]);
});
