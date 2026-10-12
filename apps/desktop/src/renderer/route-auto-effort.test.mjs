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
const { publishAutoEffort } = await import('./auto-effort-store.ts');
const { parseModelRef } = await import('./model-route-utils.ts');
const { automationAutoEffortSuffix, automationRouteSummary } = await import('./automation-editor-support.ts');

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
const autoSwitch = () => document.querySelector('input[aria-label="Auto reasoning"]');

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

test('the sheet switch reads and writes the route, not the master', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  capabilityCalls.length = 0;
  const selections = [];
  const value = { provider: 'anthropic', model: 'opus', effort: 'high' };
  await mount(t, { models: [option(true)], value, onChange: (selection) => selections.push(selection) });
  assert.equal(autoSwitch().checked, true, 'absent route flag reads as on');
  await act(async () => autoSwitch().click());
  assert.equal(selections.length, 1);
  assert.equal(selections[0].autoEffort, false);
  assert.equal(selections[0].model, 'opus');
  assert.ok(!capabilityCalls.includes('setBuiltinToolEnabled'), 'the master is never written');
});

test('only an explicit false turns the route off, and turning it back on writes true', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  const selections = [];
  const value = { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: false };
  await mount(t, { models: [option(true)], value, onChange: (selection) => selections.push(selection) });
  assert.equal(autoSwitch().checked, false);
  await act(async () => autoSwitch().click());
  assert.equal(selections[0].autoEffort, true);
});

test('a newly chosen model starts from savedAutoEffort, else on', async (t) => {
  await setMaster({ installed: true, enabled: true, supported: true });
  const selections = [];
  const other = (model, extra) => option(true, { model, display: model, ...extra });
  await mount(t, {
    models: [option(true), other('saved-off', { savedAutoEffort: false }), other('plain')],
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
  await pick('plain');
  assert.deepEqual(
    selections.map((selection) => [selection.model, selection.autoEffort]),
    [
      ['saved-off', false],
      ['plain', true],
    ]
  );
});

test('master off or an incapable model hides the switch; the route value survives', async (t) => {
  await setMaster({ installed: true, enabled: false, supported: true });
  await mount(t, {
    models: [option(true)],
    value: { provider: 'anthropic', model: 'opus', effort: 'high', autoEffort: false },
    onChange() {},
  });
  assert.equal(autoSwitch(), null, 'master off hides Auto');
  await setMaster({ installed: true, enabled: true, supported: true });
  await act(async () => document.querySelector('.model-trigger').click());
  await act(async () => document.querySelector('.model-trigger').click());
  assert.equal(autoSwitch().checked, false, 'the route kept its own off value');
});

test('labels show Auto only when the master is on and the route did not opt out', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const text = async (props) => {
    await act(async () =>
      root.render(React.createElement(ModelRouteLabel, { model: 'Opus', effort: 'high', autoEffortCapable: true, ...props }))
    );
    return host.textContent;
  };
  await setMaster({ installed: true, enabled: true, supported: true });
  assert.equal(await text({}), 'Opus Auto');
  assert.equal(await text({ autoEffort: true }), 'Opus Auto');
  assert.equal(await text({ autoEffort: false }), 'Opus High');
  await setMaster({ installed: true, enabled: false, supported: true });
  assert.equal(await text({ autoEffort: true }), 'Opus High');
  await setMaster({ installed: true, enabled: true, supported: true });
});

test('a host without per-route Auto hides the switch and never gets autoEffort or +noauto', async (t) => {
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
  assert.equal(autoSwitch(), null, 'no per-route switch on an older host');
  const modelRow = [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
    node.textContent.startsWith('Model')
  );
  await act(async () => modelRow.click());
  const row = [...document.querySelectorAll('.model-option-row')].find((node) => node.textContent.includes('plain'));
  await act(async () => row.click());
  assert.equal(selections.length, 1);
  assert.equal(selections[0].model, 'plain');
  assert.equal(Object.hasOwn(selections[0], 'autoEffort'), false, 'an ordinary pick sends no autoEffort');
  assert.equal(automationAutoEffortSuffix(false), '', 'no +noauto for a host that would misread it');
});

test('automation routes store the opt-out as a +noauto suffix and read it back', () => {
  assert.equal(automationAutoEffortSuffix(true), '');
  assert.equal(automationAutoEffortSuffix(false), '+noauto');
  const off = parseModelRef('anthropic/opus@high+fast+noauto?serviceTier=priority');
  assert.deepEqual(
    { route: off.route, effort: off.effort, fast: off.fast, autoEffort: off.autoEffort },
    { route: 'anthropic/opus', effort: 'high', fast: true, autoEffort: false }
  );
  assert.equal(parseModelRef('anthropic/opus@high').autoEffort, true);
  assert.equal(automationRouteSummary('anthropic/opus@high+noauto').autoEffort, false);
  assert.equal(automationRouteSummary('anthropic/opus@high').autoEffort, true);
});
