import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createOnboardingSteps } from './onboarding-steps.mjs';
import { agentModelParts, normalizeModelOptions, routeFromModel } from './model-options.mjs';

// The first-run wizard against a recording store and panel host: what each
// step paints, where a pick lands in onboardingRef, and what finish/skip
// persist. Surface-ownership races live in panel-epoch.test.mjs.

const MODELS = [
  { provider: 'openai', id: 'gpt-5' },
  { provider: 'anthropic', id: 'claude-sonnet-4' },
];
const GPT5 = { provider: 'openai', model: 'gpt-5' };
const CLAUDE_HIGH = { provider: 'anthropic', model: 'claude-sonnet-4', effort: 'high' };

function harness({ store: storeOverrides = {}, state = {} } = {}) {
  supersedePanelEpoch();
  let live = null;
  const painted = [];
  const notices = [];
  const opened = [];
  const active = [];
  const prompts = [];
  const calls = { completeOnboarding: [], skipOnboarding: 0 };
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
      painted.push(live);
    },
    setUsagePanel: () => {},
  });
  const store = {
    pushNotice: (message, tone) => notices.push([String(message), tone]),
    getProviderSetup: async () => ({ providers: ['openai'] }),
    listProviderModels: async () => MODELS,
    listWebSearchModels: async () => [{ provider: 'openai', id: 'gpt-5-search' }],
    listAgents: async () => [{ id: 'researcher', label: 'Researcher', description: 'digs' }, { id: 'coder' }],
    completeOnboarding: async (payload) => {
      calls.completeOnboarding.push(payload);
    },
    skipOnboarding: async () => {
      calls.skipOnboarding += 1;
    },
    ...storeOverrides,
  };
  const onboardingRef = { current: { ...state } };
  const providerModelsCacheRef = { current: { models: [], at: 0 } };
  const onboardingPrefetchSeqRef = { current: 0 };
  const steps = createOnboardingSteps({
    store,
    surface,
    setProviderPrompt: (value) => prompts.push(['provider', value]),
    setSettingsPrompt: (value) => prompts.push(['settings', value]),
    setOnboardingActive: (value) => active.push(value),
    onboardingRef,
    providerModelsCacheRef,
    onboardingPrefetchSeqRef,
    openProviderSetupPicker: (options) => opened.push(['provider', options]),
    openThemePicker: (options) => opened.push(['theme', options]),
    openOutputStylePicker: (options) => opened.push(['outputStyle', options]),
  });
  return {
    steps,
    store,
    painted,
    notices,
    opened,
    active,
    prompts,
    calls,
    onboardingRef,
    providerModelsCacheRef,
    onboardingPrefetchSeqRef,
    current: () => live,
  };
}

const ROSTER = [
  { id: 'researcher', label: 'Researcher', description: 'digs' },
  { id: 'coder', label: 'coder', description: '' },
];

test('Step 2 lists Main, Web Search and the agent roster with their routes, and hands Back/Next on', async () => {
  const h = harness({
    state: {
      defaultRoute: GPT5,
      webSearchRoute: { provider: 'default', model: 'default' },
      agentRoutes: { coder: CLAUDE_HIGH },
    },
  });
  await h.steps.openOnboardingWorkflowStep();
  await flush();
  const panel = h.current();
  assert.equal(panel.title, 'First Run · Step 2/4 · Models');
  assert.deepEqual(
    panel.items.map((item) => [item.value, item.label, item._target]),
    [
      ['main-model', 'Main', 'lead'],
      ['web-search-model', 'Web Search', 'webSearch'],
      ['agent:researcher', 'Researcher', 'researcher'],
      ['agent:coder', 'coder', 'coder'],
    ]
  );
  assert.deepEqual(panel.items[0].metaParts, agentModelParts(GPT5));
  assert.equal(panel.items[1].metaParts[0].text, '(follows main)');
  assert.deepEqual(panel.items[2].metaParts, agentModelParts(null));
  assert.deepEqual(panel.items[3].metaParts, agentModelParts(CLAUDE_HIGH));
  assert.equal(panel.items[2].description, 'digs');
  assert.deepEqual(h.onboardingRef.current.agents, ROSTER);
  assert.equal(h.providerModelsCacheRef.current.models, MODELS);
  assert.deepEqual(h.prompts, [
    ['provider', null],
    ['settings', null],
  ]);

  panel.confirmBar.onConfirm({ value: 'back' });
  await flush();
  assert.equal(h.opened[0][0], 'provider');
  assert.equal(h.opened[0][1].title, 'First Run · Step 1/4 · Provider Auth');
  panel.confirmBar.onConfirm({ value: 'next' });
  assert.equal(h.opened[1][0], 'theme');
  assert.equal(typeof h.opened[1][1].onboarding.onAdvance, 'function');
});

test('the agent role picker offers Default above the models, pre-marks the override, and stores the pick', async () => {
  const h = harness({
    state: {
      providerModels: MODELS,
      agents: [{ id: 'coder', label: 'Coder', description: '' }],
      agentRoutes: { coder: GPT5 },
    },
  });
  const normalized = normalizeModelOptions(MODELS);
  await h.steps.openOnboardingRoleModelPicker('coder');
  await flush();
  const panel = h.current();
  assert.equal(panel.title, 'First Run · Coder');
  assert.match(panel.description, /Pick the model for Coder/);
  assert.equal(panel.items[0].value, '__default__');
  assert.equal(panel.items[0].marker, '');
  assert.equal(panel.items[0].description, 'same as Main Model');
  assert.deepEqual(
    panel.items.slice(1).map((item) => item.value),
    normalized.map((m) => `${m.provider}:${m.id}`)
  );
  const gptIndex = normalized.findIndex((m) => m.id === 'gpt-5');
  assert.equal(panel.items[gptIndex + 1].marker, '✓');
  assert.equal(panel.initialIndex, gptIndex + 1);

  panel.onSelect('__default__', panel.items[0]);
  await flush();
  assert.deepEqual(h.onboardingRef.current.agentRoutes, {});
  assert.equal(h.current().title, 'First Run · Step 2/4 · Models');

  await h.steps.openOnboardingRoleModelPicker('coder');
  await flush();
  const claude = h.current().items.find((item) => item.value === 'anthropic:claude-sonnet-4');
  h.current().onSelect(claude.value, claude);
  await flush();
  assert.deepEqual(h.onboardingRef.current.agentRoutes, { coder: { provider: 'anthropic', model: 'claude-sonnet-4' } });
});

test('Main and Web Search picks land on their own routes; Web Search Default stores the marker route', async () => {
  const h = harness({ state: { providerModels: MODELS, agents: [] } });
  const normalized = normalizeModelOptions(MODELS);
  await h.steps.openOnboardingRoleModelPicker('lead');
  await flush();
  const lead = h.current();
  assert.equal(lead.title, 'First Run · Main');
  assert.equal(lead.initialIndex, 0);
  assert.ok(lead.items.every((item) => !item._default));
  lead.onSelect(lead.items[0].value, lead.items[0]);
  await flush();
  assert.deepEqual(h.onboardingRef.current.defaultRoute, routeFromModel(normalized[0]));

  await h.steps.openOnboardingRoleModelPicker('webSearch');
  await flush();
  const web = h.current();
  assert.equal(web.title, 'First Run · Web Search');
  assert.deepEqual(
    web.items.map((item) => [item.value, item.marker, item.description]),
    [
      ['__default__', '✓', 'follows Main Model'],
      ['openai:gpt-5-search', '', ''],
    ]
  );
  web.onSelect('__default__', web.items[0]);
  await flush();
  assert.deepEqual(h.onboardingRef.current.webSearchRoute, { provider: 'default', model: 'default' });

  await h.steps.openOnboardingRoleModelPicker('webSearch');
  await flush();
  assert.equal(h.current().items[0].marker, '✓');
  h.current().onSelect('openai:gpt-5-search', h.current().items[1]);
  await flush();
  assert.deepEqual(h.onboardingRef.current.webSearchRoute, { provider: 'openai', model: 'gpt-5-search' });
});

test('finish persists the full route set, only the overrides when Main is unset, or just marks done', async () => {
  const full = harness({ state: { defaultRoute: GPT5, webSearchRoute: GPT5, agentRoutes: { coder: CLAUDE_HIGH } } });
  full.steps.finishOnboarding();
  await flush();
  assert.deepEqual(full.calls.completeOnboarding, [
    { defaultRoute: GPT5, agentRoutes: { coder: CLAUDE_HIGH }, webSearchRoute: GPT5 },
  ]);
  assert.deepEqual(full.active, [false]);
  assert.deepEqual(full.painted, [null]);
  assert.deepEqual(full.notices, [['First-run setup complete.', 'info']]);

  const partial = harness({ state: { agentRoutes: { coder: CLAUDE_HIGH } } });
  partial.steps.finishOnboarding();
  await flush();
  assert.deepEqual(partial.calls.completeOnboarding, [{ agentRoutes: { coder: CLAUDE_HIGH } }]);
  assert.equal(partial.calls.skipOnboarding, 0);

  const untouched = harness();
  untouched.steps.finishOnboarding();
  await flush();
  assert.deepEqual(untouched.calls.completeOnboarding, []);
  assert.equal(untouched.calls.skipOnboarding, 1);
  assert.deepEqual(untouched.notices, [['First-run setup complete.', 'info']]);

  const failing = harness({
    state: { defaultRoute: GPT5 },
    store: {
      completeOnboarding: async () => {
        throw new Error('disk full');
      },
    },
  });
  failing.steps.finishOnboarding();
  await flush();
  assert.deepEqual(failing.notices, [['Couldn’t save setup: disk full', 'error']]);
});

test('skipping marks onboarding done and reports a late save failure', async () => {
  const h = harness();
  h.steps.onboardingWarnReopen();
  await flush();
  assert.deepEqual(h.active, [false]);
  assert.equal(h.calls.skipOnboarding, 1);
  assert.deepEqual(h.notices, [['Setup skipped. Run `mixdog --onboarding` to set up later.', 'info']]);

  const failing = harness({
    store: {
      skipOnboarding: async () => {
        throw new Error('nope');
      },
    },
  });
  failing.steps.onboardingWarnReopen();
  await flush();
  assert.deepEqual(failing.notices, [['Couldn’t save skip: nope', 'error']]);
});

test('prefetch warms Step 2 data once and drops a result from a superseded generation', async () => {
  const h = harness();
  h.steps.prefetchOnboardingStep2();
  await flush();
  assert.equal(h.onboardingRef.current.providerModels, MODELS);
  assert.equal(h.providerModelsCacheRef.current.models, MODELS);
  assert.deepEqual(h.onboardingRef.current.agents, ROSTER);

  let release;
  const stale = harness({ store: { listProviderModels: () => new Promise((resolve) => (release = resolve)) } });
  stale.steps.prefetchOnboardingStep2();
  stale.onboardingPrefetchSeqRef.current += 1;
  release(MODELS);
  await flush();
  assert.equal(stale.onboardingRef.current.providerModels, undefined);
  assert.deepEqual(stale.providerModelsCacheRef.current, { models: [], at: 0 });
});

test('Step 1 preloads the provider setup, Next opens Step 2, and the theme/output-style steps chain to finish', async () => {
  const h = harness();
  await h.steps.openOnboardingAuthStep();
  await flush();
  const [kind, options] = h.opened[0];
  assert.equal(kind, 'provider');
  assert.equal(options.title, 'First Run · Step 1/4 · Provider Auth');
  assert.deepEqual(options.preloadedSetup, { providers: ['openai'] });
  assert.deepEqual(options.confirmBar.buttons, [{ value: 'next', label: 'Next ▶' }]);
  options.confirmBar.onConfirm();
  await flush();
  assert.equal(h.current().title, 'First Run · Step 2/4 · Models');

  h.steps.openOnboardingThemeStep();
  const theme = h.opened.at(-1)[1].onboarding;
  theme.onAdvance();
  const style = h.opened.at(-1);
  assert.equal(style[0], 'outputStyle');
  assert.equal(style[1].onboarding.isLastStep, true);
  style[1].onboarding.onBack();
  assert.equal(h.opened.at(-1)[0], 'theme');
  style[1].onboarding.onAdvance();
  await flush();
  assert.equal(h.calls.skipOnboarding, 1);
});
