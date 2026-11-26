// Auto reasoning is a per-route flag (absent = on, only `false` is off). The
// route sheet writes the route it edits and never the Settings master switch.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event', 'KeyboardEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.HTMLElement.prototype.scrollIntoView = () => {};
const capabilityCalls = [];
let master = { installed: true, enabled: true, supported: true };
window.mixdogDesktop = {
  routeAutoEffort: true,
  async invokeCapability(request) {
    capabilityCalls.push(request.capability);
    return { value: { autoEffort: master } };
  },
};
after(restore);

const { createRoot } = await import('react-dom/client');
const { ModelRouteEditor } = await import('./ModelRouteEditor.tsx');
const { ModelRouteLabel } = await import('./provider-display.tsx');
const { publishAutoEffort, displayEffortLabel } = await import('./auto-effort-store.ts');
const { parseModelRef } = await import('./model-route-utils.ts');

const option = (autoEffortCapable, extra = {}) => ({
  provider: 'anthropic',
  model: 'opus',
  display: 'Opus',
  effortOptions: ['low', 'high'].map((value) => ({ value, label: value })),
  fastCapable: false,
  fastPreferred: false,
  ...(autoEffortCapable ? { autoEffortCapable: true } : {}),
  ...extra,
});

const setMaster = async (state) => {
  master = state;
  await act(async () => publishAutoEffort({ autoEffort: state }));
};
const noSwitch = () => document.querySelector('input[aria-label="Auto reasoning"]');
const autoItem = () => document.querySelector('[data-effort-option="auto"]');
const openEffort = async () => {
  if (document.querySelector('.route-sheet-option')) return;
  const row = [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
    node.textContent.startsWith('Reasoning effort')
  );
  await act(async () => row.click());
};
const effortItems = () => [...document.querySelectorAll('.route-sheet-option')];
const checkedLabel = () => effortItems().find((node) => node.getAttribute('aria-checked') === 'true')?.textContent;

async function mount(t, props) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => root.render(React.createElement(ModelRouteEditor, { composerParity: true, ...props })));
  await act(async () => document.querySelector('.model-trigger').click());
  return host;
}

test('Auto is the first effort item, checked when effortAuto is true; picking a level writes effortAuto: false, not the master', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  capabilityCalls.length = 0;
  const efforts = [];
  const value = { provider: 'anthropic', model: 'opus', effort: 'high', effortAuto: true };
  await mount(t, {
    models: [option(true)],
    value,
    onChange: (selection) => efforts.push(selection),
  });
  assert.equal(noSwitch(), null, 'no Auto reasoning switch row');
  assert.match(
    [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
      node.textContent.startsWith('Reasoning effort')
    ).textContent,
    /Auto/,
    'the row shows Auto while on'
  );
  await openEffort();
  assert.equal(effortItems()[0], autoItem(), 'Auto is first');
  assert.equal(checkedLabel(), 'Auto', 'explicit effortAuto: true reads as on');
  assert.equal(
    effortItems()[2].getAttribute('aria-checked'),
    'false',
    'the saved level is not checked while Auto is on'
  );
  await act(async () => effortItems()[2].click());
  assert.equal(efforts.length, 1);
  assert.equal(efforts[0].effortAuto, false);
  assert.equal(efforts[0].effort, 'high', 'picking the saved level still turns Auto off');
  assert.ok(!capabilityCalls.includes('setBuiltinToolEnabled'), 'the master is never written');
});

test('effortAuto: false shows the saved level, and picking Auto writes effortAuto: true', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  const selections = [];
  const value = { provider: 'anthropic', model: 'opus', effort: 'high', effortAuto: false };
  await mount(t, { models: [option(true)], value, onChange: (selection) => selections.push(selection) });
  await openEffort();
  assert.equal(checkedLabel(), 'high');
  assert.equal(autoItem().getAttribute('aria-checked'), 'false');
  await act(async () => autoItem().click());
  assert.equal(selections[0].effortAuto, true);
  assert.equal(selections[0].model, 'opus');
});

test('picking Auto over a saved max keeps that level, and the row reads Auto', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  const levels = ['low', 'high', 'max'].map((value) => ({ value, label: value }));
  const models = [option(true, { effortOptions: levels })];
  const selections = [];
  const first = await mount(t, {
    models,
    value: { provider: 'anthropic', model: 'opus', effort: 'max', effortAuto: false },
    onChange: (selection) => selections.push(selection),
  });
  await openEffort();
  await act(async () => autoItem().click());
  assert.equal(selections[0].effortAuto, true);
  assert.equal(selections[0].effort, 'max');
  // The same route with Auto on and that level reads Auto, checked.
  assert.equal(displayEffortLabel(selections[0].effort, { autoOn: true, capable: true }), 'Auto');
  assert.ok(first);
});

test('a model without Auto support has no Auto item', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  await mount(t, {
    models: [option(false)],
    value: { provider: 'anthropic', model: 'opus', effort: 'high' },
    onChange() {},
  });
  await openEffort();
  assert.equal(autoItem(), null);
  assert.deepEqual(
    effortItems().map((node) => node.textContent),
    ['low', 'high']
  );
});

test('a newly chosen model preserves savedEffortAuto and omits effortAuto when unpicked, even with judge uninstalled', async (t) => {
  await setMaster({ installed: false, enabled: true, supported: true });
  const selections = [];
  const other = (model, extra) => option(true, { model, display: model, ...extra });
  await mount(t, {
    models: [
      option(true),
      other('saved-off', { savedEffortAuto: false }),
      other('saved-on', { savedEffortAuto: true }),
      other('plain'),
    ],
    value: { provider: 'anthropic', model: 'opus', effort: 'high' },
    onChange: (selection) => selections.push(selection),
  });
  const pick = async (name) => {
    if (!document.querySelector('.model-option-row')) {
      const modelRow = [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
        node.textContent.startsWith('Model')
      );
      await act(async () => modelRow.click());
    }
    const row = [...document.querySelectorAll('.model-option-row')].find((node) => node.textContent.includes(name));
    await act(async () => row.click());
    await act(async () => document.querySelector('.model-trigger').click());
  };
  await pick('saved-off');
  await pick('saved-on');
  await pick('plain');
  assert.deepEqual(
    selections.map((selection) => [selection.model, Object.hasOwn(selection, 'effortAuto'), selection.effortAuto]),
    [
      ['saved-off', true, false],
      ['saved-on', true, true],
      ['plain', false, undefined],
    ]
  );
  await setMaster({ installed: true, enabled: true, supported: true });
});

test('legacy switch off still offers Auto in the picker; judge uninstalled hides Auto and preserves route value', async (t) => {
  await setMaster({ installed: true, enabled: false, supported: true });
  const selections = [];
  await mount(t, {
    models: [option(true)],
    value: { provider: 'anthropic', model: 'opus', effort: 'high', effortAuto: false },
    onChange: (selection) => selections.push(selection),
  });
  await openEffort();
  assert.notEqual(autoItem(), null, 'Auto remains offered as an effort choice when legacy switch is off');
  assert.equal(autoItem().getAttribute('aria-checked'), 'false');
  await act(async () => autoItem().click());
  assert.equal(selections[0].effortAuto, true, 'user can explicitly choose Auto regardless of legacy switch');

  await setMaster({ installed: false, enabled: false, supported: true });
  await act(async () => document.querySelector('.model-trigger').click());
  await act(async () => document.querySelector('.model-trigger').click());
  await openEffort();
  assert.equal(autoItem(), null, 'uninstalled judge hides Auto');
  await setMaster({ installed: true, enabled: true, supported: true });
  await act(async () => document.querySelector('.model-trigger').click());
  await act(async () => document.querySelector('.model-trigger').click());
  await openEffort();
  assert.equal(autoItem().getAttribute('aria-checked'), 'false', 'the route kept its own off value');
});

test('labels read ONLY explicit effortAuto and never consult the legacy switch at display time', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const text = async (props) => {
    await act(async () =>
      root.render(
        React.createElement(ModelRouteLabel, { model: 'Opus', effort: 'high', autoEffortCapable: true, ...props })
      )
    );
    return host.textContent;
  };
  await setMaster({ installed: true, enabled: true, supported: true });
  assert.equal(await text({}), 'Opus High', 'absent effortAuto never reads the legacy switch');
  assert.equal(await text({ effortAuto: true }), 'Opus Auto');
  assert.equal(await text({ effortAuto: false }), 'Opus High');
  await setMaster({ installed: true, enabled: false, supported: true });
  assert.equal(await text({}), 'Opus High');
  assert.equal(await text({ effortAuto: true }), 'Opus Auto', 'explicit effortAuto true stays Auto');
  assert.equal(await text({ effortAuto: true, turnEffort: 'low' }), 'Opus Auto (Low)');
  await setMaster({ installed: true, enabled: true, supported: true });
});

test('RouteEditor shows the turn resolved effort alongside Auto in trigger, row, and effort pane', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  await mount(t, {
    models: [option(true)],
    value: { provider: 'anthropic', model: 'opus', effort: 'low', effortAuto: true },
    turnEffort: 'high',
    onChange() {},
  });
  assert.match(document.querySelector('.model-trigger').textContent, /Auto \(High\)/);
  assert.match(
    [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
      node.textContent.startsWith('Reasoning effort')
    ).textContent,
    /Auto \(High\)/
  );
  await openEffort();
  assert.equal(checkedLabel(), 'Auto (High)');
});

test('a host without per-route Auto hides the switch and never gets effortAuto or +noauto', async (t) => {
  window.mixdogDesktop.routeAutoEffort = false;
  t.after(() => {
    window.mixdogDesktop.routeAutoEffort = true;
  });
  await setMaster({ installed: true, enabled: true, supported: true });
  const selections = [];
  await mount(t, {
    models: [option(true), option(true, { model: 'plain', display: 'plain' })],
    value: { provider: 'anthropic', model: 'opus', effort: 'high' },
    onChange: (selection) => selections.push(selection),
  });
  await openEffort();
  assert.equal(autoItem(), null, 'no Auto item on an older host');
  const modelRow = [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
    node.textContent.startsWith('Model')
  );
  await act(async () => modelRow.click());
  const row = [...document.querySelectorAll('.model-option-row')].find((node) => node.textContent.includes('plain'));
  await act(async () => row.click());
  assert.equal(selections.length, 1);
  assert.equal(selections[0].model, 'plain');
  assert.equal(Object.hasOwn(selections[0], 'effortAuto'), false, 'an ordinary pick sends no effortAuto');
});

test('a stored model route reads its +noauto opt-out back', () => {
  const off = parseModelRef('anthropic/opus@high+fast+noauto?serviceTier=priority');
  assert.deepEqual(
    { route: off.route, effort: off.effort, fast: off.fast, effortAuto: off.effortAuto },
    { route: 'anthropic/opus', effort: 'high', fast: true, effortAuto: false }
  );
  assert.equal(parseModelRef('anthropic/opus@high').effortAuto, undefined);
});
