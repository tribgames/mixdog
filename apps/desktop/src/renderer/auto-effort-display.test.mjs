import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'CustomEvent'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { WorkflowsPane } = await import('./WorkflowsView.tsx');
const { ModelRouteLabel } = await import('./provider-display.tsx');
const { AgentRouteSummary } = await import('./agent-row-parts.tsx');
const { writeCachedModelCatalog } = await import('./model-catalog-cache.ts');
const {
  convertLegacyAutoEffort,
  displayEffortLabel,
  effortAutoField,
  effortAutoKey,
  formatAutoEffortLabel,
  mergeEffortAuto,
  needsLegacyAutoEffortConversion,
  pickEffortAuto,
  publishAutoEffort,
  readEffortAuto,
  resolveEffortAuto,
  routeAutoEffortActive,
} = await import('./auto-effort-store.ts');
const { convertDraftPanePrefs, convertLegacyModelSelection } = await import('./draft-pane-prefs-store.ts');
const { createSessionLaneStore } = await import('./session-lane-store.ts');
const { adoptSidebarReferenceHost, resetSidebarReferenceCache, updateSidebarReference } = await import(
  './sidebar-reference-cache.ts'
);

const setSwitch = (enabled, installed = true) =>
  act(async () => publishAutoEffort({ autoEffort: { installed, enabled, supported: true } }));

test('explicit effortAuto helpers and single legacy conversion never mistake legacy true for Auto when switch is off', () => {
  assert.equal(readEffortAuto(undefined), undefined);
  assert.equal(readEffortAuto(null), undefined);
  assert.equal(readEffortAuto(true), true);
  assert.equal(readEffortAuto(false), false);
  assert.equal(pickEffortAuto(undefined, null), undefined);
  assert.equal(pickEffortAuto(undefined, true, false), true);
  assert.equal(pickEffortAuto(false, true), false);
  assert.deepEqual(effortAutoField(undefined, true), {});
  assert.deepEqual(effortAutoField(true, true), { effortAuto: true });
  assert.deepEqual(effortAutoField(false, true), { effortAuto: false });
  assert.deepEqual(effortAutoField(true, false), {});
  assert.equal(mergeEffortAuto(true, undefined), true);
  assert.equal(mergeEffortAuto(undefined, false), false);
  assert.equal(mergeEffortAuto(true, false), false);
  assert.equal(mergeEffortAuto(undefined, undefined), undefined);
  assert.deepEqual([effortAutoKey(true), effortAutoKey(false), effortAutoKey(undefined)], ['1', '0', '']);

  // One-time legacy conversion: old `autoEffort: true` is Auto ONLY when switch is on.
  assert.equal(convertLegacyAutoEffort(true, true), true);
  assert.equal(convertLegacyAutoEffort(true, false), false);
  assert.equal(convertLegacyAutoEffort(undefined, true), true);
  assert.equal(convertLegacyAutoEffort(undefined, false), false);
  assert.equal(convertLegacyAutoEffort(false, true), false);
  assert.equal(resolveEffortAuto({ effortAuto: true, autoEffort: false }, false), true);
  assert.equal(resolveEffortAuto({ effortAuto: false, autoEffort: true }, true), false);
  assert.equal(resolveEffortAuto({ autoEffort: true }, false), false);
  assert.equal(resolveEffortAuto({ autoEffort: true }, true), true);

  // Display/turn check NEVER reads the legacy switch; only explicit effortAuto === true + installed judge activates Auto.
  assert.equal(routeAutoEffortActive(undefined, { installed: false, enabled: true, supported: true }), false);
  assert.equal(routeAutoEffortActive(undefined, { installed: true, enabled: false, supported: true }), false);
  assert.equal(routeAutoEffortActive(undefined, { installed: true, enabled: true, supported: true }), false);
  assert.equal(routeAutoEffortActive(true, { installed: false, enabled: true, supported: true }), false);
  assert.equal(routeAutoEffortActive(true, { installed: true, enabled: false, supported: true }), true);
  assert.equal(routeAutoEffortActive(false, { installed: true, enabled: true, supported: true }), false);
});

test('update regression: legacy localStorage prefs with autoEffort: true convert across switch-on, switch-off, and uninstalled judge', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const labelFor = async (selection) => {
    await act(async () =>
      root.render(
        React.createElement(ModelRouteLabel, {
          model: 'Opus',
          effort: selection.effort,
          effortAuto: selection.effortAuto,
          autoEffortCapable: true,
        })
      )
    );
    return host.textContent;
  };
  const legacyPrefs = {
    projectPath: '/work',
    modelSelection: { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: true },
    workflow: null,
  };
  assert.equal(needsLegacyAutoEffortConversion(legacyPrefs.modelSelection), true);

  // 1. Switch ON + judge installed -> Auto
  await setSwitch(true, true);
  const convertedOn = convertDraftPanePrefs(legacyPrefs, true);
  assert.equal(convertedOn.modelSelection.effortAuto, true);
  assert.equal(Object.hasOwn(convertedOn.modelSelection, 'autoEffort'), false);
  assert.equal(needsLegacyAutoEffortConversion(convertedOn.modelSelection), false);
  assert.equal(await labelFor(convertedOn.modelSelection), 'Opus Auto');

  // 2. Switch OFF + judge installed -> Manual (legacy autoEffort: true is NOT Auto!)
  await setSwitch(false, true);
  const convertedOff = convertDraftPanePrefs(legacyPrefs, false);
  assert.equal(convertedOff.modelSelection.effortAuto, false);
  assert.equal(Object.hasOwn(convertedOff.modelSelection, 'autoEffort'), false);
  assert.equal(await labelFor(convertedOff.modelSelection), 'Opus High');

  // 3. Judge NOT installed + switch ON -> displays saved level, never Auto
  await setSwitch(true, false);
  const convertedNoJudge = convertLegacyModelSelection(legacyPrefs.modelSelection, true);
  assert.equal(convertedNoJudge.effortAuto, true);
  assert.equal(await labelFor(convertedNoJudge), 'Opus High');
});

test('session-lane-store does not refill effortAuto or effort from prior model after a model switch', () => {
  const store = createSessionLaneStore();
  store.apply({
    sessionId: 's1',
    frameSource: 'live',
    contentRevision: 1,
    snapshot: {
      sessionId: 's1',
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
      effortAuto: true,
      fast: true,
      items: [{ id: 'm1', kind: 'user', text: 'hi' }],
    },
  });
  assert.equal(store.get('s1')?.effortAuto, true);
  // Same-generation model switch to a different model without effortAuto must not inherit prior model's effortAuto/effort/fast.
  store.apply({
    sessionId: 's1',
    frameSource: 'live',
    contentRevision: 1,
    snapshot: {
      sessionId: 's1',
      provider: 'openai',
      model: 'gpt-5',
      items: [{ id: 'm1', kind: 'user', text: 'hi' }],
    },
  });
  const after = store.get('s1');
  assert.equal(after?.provider, 'openai');
  assert.equal(after?.model, 'gpt-5');
  assert.equal(after?.effortAuto, undefined);
  assert.equal(after?.effort, undefined);
  assert.equal(after?.fast, undefined);
});

test('AgentRouteSummary never shows · Auto on a hopped observed request without effortAuto, and shows · Auto when judged', async (t) => {
  await act(async () =>
    writeCachedModelCatalog([
      { provider: 'anthropic', model: 'opus', display: 'Opus', autoEffortCapable: true, effortOptions: [] },
    ])
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    writeCachedModelCatalog([]);
  });
  await setSwitch(true);
  await act(async () =>
    root.render(
      React.createElement(AgentRouteSummary, {
        agent: {
          provider: 'anthropic',
          model: 'opus',
          effort: 'high',
          routeObserved: true,
          status: 'running',
        },
      })
    )
  );
  assert.doesNotMatch(host.textContent, /· Auto/, 'hopped request with absent effortAuto must not claim · Auto');

  await act(async () =>
    root.render(
      React.createElement(AgentRouteSummary, {
        agent: {
          provider: 'anthropic',
          model: 'opus',
          effort: 'high',
          routeObserved: true,
          effortAuto: true,
          status: 'running',
        },
      })
    )
  );
  assert.match(host.textContent, /· Auto/, 'observed request with explicit effortAuto: true shows · Auto');
});

test('displayEffortLabel: Auto when on + capable, whatever level is saved', () => {
  const on = { autoOn: true, capable: true };
  assert.equal(displayEffortLabel('high', on), 'Auto');
  assert.equal(displayEffortLabel('', on), 'Auto');
  assert.equal(displayEffortLabel('max', on), 'Auto');
  assert.equal(displayEffortLabel('ULTRA', on), 'Auto');
  assert.equal(displayEffortLabel('high', { autoOn: false, capable: true }), null);
  assert.equal(displayEffortLabel('high', { autoOn: true, capable: false }), null);
});

test('ModelRouteLabel follows explicit effortAuto and judge availability, respecting capability and max/ultra', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const text = async (props) => {
    await act(async () => root.render(React.createElement(ModelRouteLabel, { model: 'Opus', ...props })));
    return host.textContent;
  };
  await setSwitch(false, false);
  assert.equal(await text({ effort: 'high', effortAuto: true, autoEffortCapable: true }), 'Opus High');
  await setSwitch(false, true);
  assert.equal(await text({ effort: 'high', effortAuto: true, autoEffortCapable: true }), 'Opus Auto');
  assert.equal(await text({ effort: 'high', effortAuto: true, autoEffortCapable: false }), 'Opus High');
  assert.equal(await text({ effort: 'max', effortAuto: true, autoEffortCapable: true }), 'Opus Auto');
  assert.equal(await text({ effort: 'ultra', effortAuto: true, autoEffortCapable: true }), 'Opus Auto');
  assert.equal(await text({ effort: 'max', effortAuto: true, autoEffortCapable: false }), 'Opus Max');
  assert.equal(await text({ effort: 'high', autoEffortCapable: true }), 'Opus High');
  assert.equal(await text({ effort: 'low', effortAuto: true, turnEffort: 'high', autoEffortCapable: true }), 'Opus Auto (High)');
  assert.equal(await text({ effort: 'low', effortAuto: true, turnEffort: 'xhigh', autoEffortCapable: true }), 'Opus Auto (XHigh)');
  assert.equal(await text({ effort: 'low', effortAuto: false, turnEffort: 'high', autoEffortCapable: true }), 'Opus Low');
  assert.equal(formatAutoEffortLabel(''), 'Auto');
  assert.equal(formatAutoEffortLabel('medium'), 'Auto (Medium)');
  assert.equal(formatAutoEffortLabel('xhigh'), 'Auto (XHigh)');
});

test('a shown Auto label re-reads judge availability when a setting changes elsewhere', async (t) => {
  const { announceSetupChange } = await import('./setup-change-refresh.ts');
  let judgeInstalled = true;
  window.mixdogDesktop.invokeCapability = async ({ capability }) => {
    assert.equal(capability, 'getToolModuleSettings');
    return { value: { autoEffort: { installed: judgeInstalled, enabled: true, supported: true } } };
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop.invokeCapability;
    await setSwitch(false);
  });
  await setSwitch(true, true);
  await act(async () =>
    root.render(React.createElement(ModelRouteLabel, { model: 'Opus', effort: 'high', effortAuto: true, autoEffortCapable: true }))
  );
  assert.equal(host.textContent, 'Opus Auto');
  // Judge uninstalled elsewhere.
  judgeInstalled = false;
  await act(async () => {
    announceSetupChange('settings_changed');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(host.textContent, 'Opus High');
});

test('a change announced while the judge state is being read is read again after it', async (t) => {
  const { announceSetupChange } = await import('./setup-change-refresh.ts');
  const answers = [];
  window.mixdogDesktop.invokeCapability = () => {
    const answer = Promise.withResolvers();
    answers.push(answer);
    return answer.promise;
  };
  const reply = (installed) => ({ value: { autoEffort: { installed, enabled: true, supported: true } } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop.invokeCapability;
    await setSwitch(false);
  });
  await setSwitch(true, true);
  await act(async () =>
    root.render(React.createElement(ModelRouteLabel, { model: 'Opus', effort: 'high', effortAuto: true, autoEffortCapable: true }))
  );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => announceSetupChange('settings_changed'));
  assert.equal(answers.length, 1);
  await act(async () => announceSetupChange('settings_changed'));
  answers[0].resolve(reply(true));
  await settle();
  assert.equal(answers.length, 2, 'a follow-up read was queued');
  answers[1].resolve(reply(false));
  await settle();
  assert.equal(host.textContent, 'Opus High');
});

const route = (provider, model, effort, extra = {}) => ({ provider, model, effort, ...extra });

async function mountWorkflowsSummaries(t) {
  const effortOptions = ['low', 'medium', 'high', 'max'].map((value) => ({ value, label: value }));
  const option = (provider, model, autoEffortCapable) => ({
    provider,
    model,
    display: model,
    effortOptions,
    fastCapable: false,
    ...(autoEffortCapable ? { autoEffortCapable: true } : {}),
  });
  const api = {
    async invokeCapability() {
      return { value: undefined };
    },
    async listProviderModels() {
      return [];
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('workflows', []);
  updateSidebarReference('agents', [
    { id: 'worker', label: 'Worker', routeConfigured: true, route: route('alpha', 'capable', 'medium', { effortAuto: true }) },
    { id: 'heavy', label: 'Heavy', kind: 'agent', routeConfigured: true, route: route('alpha', 'plain', 'high', { effortAuto: true }) },
    { id: 'maxed', label: 'Maxed', kind: 'agent', routeConfigured: true, route: route('alpha', 'capable', 'max', { effortAuto: true }) },
    { id: 'maintainer', label: 'Maintainer', routeConfigured: true, route: route('alpha', 'capable', 'low', { effortAuto: true }) },
  ]);
  updateSidebarReference('webSearchRoute', route('alpha', 'capable', 'low'));
  updateSidebarReference('webSearchModels', [option('alpha', 'capable', true)]);
  updateSidebarReference('providerSetup', { api: [{ id: 'alpha', authenticated: true }] });
  updateSidebarReference('quickProviderModels', [option('alpha', 'capable', true), option('alpha', 'plain', false)]);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
    await setSwitch(false);
  });
  await setSwitch(false, false);
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
  });
  return () =>
    Object.fromEntries(
      [...host.querySelectorAll('.workflows-agent-summary-row')].map((row) => [
        row.querySelector('b')?.textContent,
        row.querySelector('.agent-route-summary')?.textContent,
      ])
    );
}

test('Workflows sidebar rows (agents and default agents) show Auto for capable models only when judge is installed', async (t) => {
  const summaries = await mountWorkflowsSummaries(t);
  const off = summaries();
  assert.equal(off.Worker, 'capable Medium');
  assert.equal(off.Maintainer, 'capable Low');
  await setSwitch(false, true);
  const on = summaries();
  assert.equal(on.Worker, 'capable Auto');
  assert.equal(on.Heavy, 'plain High');
  assert.equal(on.Maxed, 'capable Auto');
  assert.equal(on.Maintainer, 'capable Auto');
});

test('the Web Search row never shows Auto: its stored effort, or Follows Main on the default route', async (t) => {
  const summaries = await mountWorkflowsSummaries(t);
  await setSwitch(true, true);
  assert.equal(summaries()['Web Search'], 'capable Low');
  await act(async () =>
    updateSidebarReference('webSearchRoute', { ...route('alpha', 'capable', 'low'), effortAuto: true })
  );
  assert.equal(summaries()['Web Search'], 'capable Low');
  await act(async () => updateSidebarReference('webSearchRoute', { provider: 'default', model: 'default' }));
  assert.equal(summaries()['Web Search'], 'Follows Main');
});
