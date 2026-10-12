// The Daybreak Blue toggle is a route model parameter: the row exists only
// when the catalog offered it for the model, and the route label says Blue.
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
after(restore);

const { createRoot } = await import('react-dom/client');
const { RouteEditor } = await import('./RouteEditor.tsx');
const { routeDaybreakBlue } = await import('./provider-display.tsx');
const { ModelRouteEditor } = await import('./ModelRouteEditor.tsx');

const noop = () => {};
const DAYBREAK = {
  id: 'daybreak',
  label: 'Daybreak Blue',
  kind: 'boolean',
  options: [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' },
  ],
};

async function renderEditor(
  t,
  { modelParameterOptions, modelParameters, autoEffort = null, onChangeModelParameter = noop }
) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(RouteEditor, {
        models: [],
        provider: 'openai-oauth',
        model: 'gpt-6-sol',
        triggerModel: 'GPT-6 Sol',
        effort: 'xhigh',
        effortOptions: [{ value: 'xhigh', label: 'Extra High' }],
        fast: false,
        fastVisible: false,
        fastAvailable: false,
        contextVisible: false,
        contextPercent: 100,
        contextDefaultPercent: 100,
        contextTokens: 0,
        modelParameterOptions,
        modelParameters,
        catalogLoaded: true,
        catalogRefreshing: false,
        catalogError: '',
        providerSetupError: '',
        modelDisabled: false,
        tuningDisabled: false,
        onSelectModel: noop,
        onChangeEffort: noop,
        onChangeSpeed: noop,
        onChangeContext: noop,
        onChangeModelParameter,
        autoEffort,
        onChangeAutoEffort: noop,
      })
    )
  );
  return host;
}

const sheetRows = () => [...document.querySelectorAll('.route-sheet-rows > .route-sheet-row')];
const daybreakSwitch = () => document.querySelector('[data-route-toggle="daybreak"] input[type="checkbox"]');

test('a Blue model shows one Daybreak Blue switch, right under Auto reasoning, writing the route parameter', async (t) => {
  const changes = [];
  const host = await renderEditor(t, {
    modelParameterOptions: [DAYBREAK],
    modelParameters: { daybreak: 'on' },
    autoEffort: { enabled: false, pending: false },
    onChangeModelParameter: (id, value) => changes.push([id, value]),
  });
  assert.match(host.querySelector('.model-trigger').textContent, /GPT-6 Sol Blue XHigh/);
  await act(async () => host.querySelector('.model-trigger').click());
  const labels = sheetRows().map((row) => row.textContent);
  const autoAt = labels.findIndex((text) => text.includes('Auto reasoning'));
  assert.ok(autoAt >= 0, 'Auto reasoning row present');
  assert.match(labels[autoAt + 1], /Daybreak Blue/, 'Daybreak Blue sits directly under Auto reasoning');
  assert.equal(labels.filter((text) => text.includes('Daybreak Blue')).length, 1, 'a single control');
  const toggle = daybreakSwitch();
  assert.equal(toggle.checked, true);
  await act(async () => toggle.click());
  assert.deepEqual(changes, [['daybreak', 'off']]);
});

test('switching Blue on writes the route parameter even without the Auto row', async (t) => {
  const changes = [];
  await renderEditor(t, {
    modelParameterOptions: [DAYBREAK],
    modelParameters: {},
    onChangeModelParameter: (id, value) => changes.push([id, value]),
  });
  await act(async () => document.querySelector('.model-trigger').click());
  const toggle = daybreakSwitch();
  assert.equal(toggle.checked, false);
  await act(async () => toggle.click());
  assert.deepEqual(changes, [['daybreak', 'on']]);
});

test('the agent-role editor saves Blue on that route only', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const option = {
    provider: 'openai-oauth',
    model: 'gpt-6-sol',
    display: 'GPT-6 Sol',
    effortOptions: [{ value: 'xhigh', label: 'Extra High' }],
    modelParameterOptions: [DAYBREAK],
  };
  const selections = [];
  await act(async () =>
    root.render(
      React.createElement(ModelRouteEditor, {
        models: [option],
        value: { provider: 'openai-oauth', model: 'gpt-6-sol', effort: 'xhigh', modelParameters: {} },
        onChange: (selection) => selections.push(selection),
      })
    )
  );
  await act(async () => host.querySelector('.model-trigger').click());
  await act(async () => daybreakSwitch().click());
  assert.equal(selections.length, 1);
  assert.equal(selections[0].model, 'gpt-6-sol');
  assert.equal(selections[0].modelParameters.daybreak, 'on');
});

test('a model without the catalog capability has no switch and never reads as Blue', async (t) => {
  const host = await renderEditor(t, { modelParameterOptions: [], modelParameters: { daybreak: 'on' } });
  assert.doesNotMatch(host.querySelector('.model-trigger').textContent, /Blue/);
  await act(async () => host.querySelector('.model-trigger').click());
  assert.equal(daybreakSwitch(), null);
  assert.equal(sheetRows().some((row) => row.textContent.includes('Daybreak Blue')), false);
  assert.equal(routeDaybreakBlue({ daybreak: 'on' }, []), false);
  assert.equal(routeDaybreakBlue({ daybreak: 'off' }, [DAYBREAK]), false);
  assert.equal(routeDaybreakBlue({ daybreak: 'on' }, [DAYBREAK]), true);
});
