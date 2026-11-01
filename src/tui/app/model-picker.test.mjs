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

const SPEED_OPTION = {
  id: 'serviceTier',
  label: 'Speed',
  kind: 'enum',
  options: [
    { value: 'priority', label: 'Fast' },
    { value: 'ultrafast', label: 'Ultrafast' },
  ],
};

test('Tab cycles Standard → Fast → Ultrafast → Standard when the model offers Ultrafast', async () => {
  const models = [
    {
      provider: 'anthropic',
      id: 'ultra-1',
      display: 'Ultra',
      fastCapable: true,
      modelParameterOptions: [SPEED_OPTION],
    },
  ];
  const h = createHarness({ models, state: { model: 'other' } });
  await h.openProvider();
  const tab = () => h.current().onTab(h.row('ultra-1'));
  const speed = () => h.footerText('ultra-1').filter((t) => /Fast|Ultrafast/.test(t));
  const picker = h.current();
  assert.deepEqual(speed(), ['Fast Off · Tab Toggle']);
  tab();
  assert.deepEqual(speed(), ['Fast On · Tab Toggle']);
  tab();
  assert.deepEqual(speed(), ['Ultrafast · Tab Toggle']);
  picker.onSelect(h.row('ultra-1').value, h.row('ultra-1'));
  await flush();
  assert.equal(h.routes.at(-1).fast, true);
  assert.equal(h.routes.at(-1).modelParameters.serviceTier, 'ultrafast');
  const g = createHarness({ models, state: { model: 'other' } });
  await g.openProvider();
  g.current().onTab(g.row('ultra-1'));
  g.current().onTab(g.row('ultra-1'));
  g.current().onTab(g.row('ultra-1'));
  assert.deepEqual(
    g.footerText('ultra-1').filter((t) => /Fast|Ultrafast/.test(t)),
    ['Fast Off · Tab Toggle']
  );
  const standard = g.current();
  standard.onSelect(g.row('ultra-1').value, g.row('ultra-1'));
  await flush();
  assert.equal(g.routes.at(-1).fast, false);
  assert.equal(g.routes.at(-1).modelParameters.serviceTier, undefined);
});
test('Tab keeps the plain on/off toggle without the ultrafast option', async () => {
  const models = [{ provider: 'anthropic', id: 'plain-fast', display: 'PF', fastCapable: true }];
  const h = createHarness({ models, state: { model: 'other' } });
  await h.openProvider();
  const tab = () => h.current().onTab(h.row('plain-fast'));
  tab();
  assert.deepEqual(h.footerText('plain-fast'), ['Fast On · Tab Toggle']);
  tab();
  assert.deepEqual(h.footerText('plain-fast'), ['Fast Off · Tab Toggle']);
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

const ROUTING_OPTION = {
  id: 'providerSort',
  label: 'Routing',
  kind: 'enum',
  options: [
    { value: 'auto', label: 'Auto' },
    { value: 'price', label: 'Price first' },
    { value: 'throughput', label: 'Speed first' },
    { value: 'latency', label: 'Latency first' },
  ],
};

test('R cycles OpenRouter Routing through its four values and Enter saves providerSort', async () => {
  const models = [
    { provider: 'anthropic', id: 'or-1', display: 'OR', modelParameterOptions: [ROUTING_OPTION] },
    { provider: 'anthropic', id: 'plain-1', display: 'Plain' },
  ];
  const h = createHarness({ models, state: { model: 'other' } });
  await h.openProvider();
  const routing = () => h.footerText('or-1').filter((t) => t.startsWith('Routing'));
  assert.deepEqual(routing(), ['Routing: Auto · R Cycle']);
  const labels = [];
  for (let i = 0; i < 4; i += 1) {
    h.current().onKey('r', {}, h.row('or-1'));
    labels.push(routing()[0]);
  }
  assert.deepEqual(labels, [
    'Routing: Price first · R Cycle',
    'Routing: Speed first · R Cycle',
    'Routing: Latency first · R Cycle',
    'Routing: Auto · R Cycle',
  ]);
  h.current().onKey('R', {}, h.row('or-1'));
  // A row without the option shows no Routing line and R does nothing.
  h.current().onKey('r', {}, h.row('plain-1'));
  assert.equal(
    h.footerText('plain-1').some((t) => t.startsWith('Routing')),
    false
  );
  const picker = h.current();
  picker.onSelect(h.row('or-1').value, h.row('or-1'));
  await flush();
  assert.equal(h.routes.at(-1).modelParameters.providerSort, 'price');
});
