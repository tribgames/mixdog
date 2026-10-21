// A conversation's workflow and delegation mode live in its model menu: rows
// below a separator, each opening the New Task chip's option list.
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

const calls = [];
window.mixdogDesktop = {
  rendererDiagnostic() {},
  async invokeCapability(request) {
    calls.push(request);
    if (request.capability === 'listWorkflows') return { value: [], snapshot: null };
    return { value: request.args[0], snapshot: null };
  },
};

const { createRoot } = await import('react-dom/client');
const { RouteEditor } = await import('./RouteEditor.tsx');
const { useSessionRouteChoices } = await import('./model-controls.tsx');
const { storeWorkflowOptions } = await import('./workflow-options-cache.ts');

const noop = () => {};
const TWO_WORKFLOWS = [
  { value: 'default', label: 'Default', active: true },
  { value: 'review', label: 'Review', active: false },
];

function Menu({ sessionId, mode, pendingMode }) {
  const sessionChoices = useSessionRouteChoices({
    sessionId,
    workflow: { id: 'default', name: 'Default' },
    mode,
    pendingMode,
    disabled: false,
    invokeResult: (work) => work(),
    applySnapshot: noop,
  });
  return React.createElement(RouteEditor, {
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
    sessionChoices,
  });
}

async function openMenu(t, props, workflows = TWO_WORKFLOWS) {
  storeWorkflowOptions(workflows);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => root.render(React.createElement(Menu, props)));
  await act(async () => host.querySelector('.model-trigger').click());
  return host;
}

const rows = () =>
  [...document.querySelectorAll('.route-sheet-rows > .route-sheet-row')].map((row) => row.textContent.trim());

test('a conversation’s model menu carries its workflow and delegation rows below a separator', async (t) => {
  await openMenu(t, { sessionId: 'sess_1', mode: 'swarm' });
  assert.deepEqual(rows(), ['ModelGPT-6 Sol', 'Reasoning effortExtra High', 'WorkflowDefault', 'Delegation modeSwarm']);
  const separator = document.querySelector('.route-sheet-rows > .route-sheet-separator');
  assert.ok(separator);
  assert.equal(separator.nextElementSibling.textContent.trim(), 'WorkflowDefault');

  const modeRow = [...document.querySelectorAll('.route-sheet-row')].find((row) =>
    /Delegation mode/.test(row.textContent)
  );
  await act(async () => modeRow.click());
  const options = [...document.querySelectorAll('.route-sheet-option')];
  assert.deepEqual(
    options.map((option) => option.textContent),
    [
      'SoloNo delegation',
      'AssistedSupporting delegation',
      'CollaborativeBalanced delegation',
      'SwarmMaximum delegation',
    ]
  );
  assert.equal(options[3].getAttribute('aria-checked'), 'true');
  calls.length = 0;
  await act(async () => options[0].click());
  assert.deepEqual(calls, [
    { capability: 'setOrchestrationMode', args: ['none', { scope: 'session' }], sessionId: 'sess_1' },
  ]);
});

test('with one workflow the workflow row is left out', async (t) => {
  await openMenu(t, { sessionId: 'sess_1', mode: 'balanced' }, [TWO_WORKFLOWS[0]]);
  assert.deepEqual(rows(), ['ModelGPT-6 Sol', 'Reasoning effortExtra High', 'Delegation modeCollaborative']);
});

test('a change waiting for the next response says so on its row', async (t) => {
  await openMenu(t, { sessionId: 'sess_1', mode: 'none', pendingMode: true });
  assert.equal(rows().at(-1), 'Delegation modeSolo · From the next response');
});

test('a New Task draft’s model menu has no session rows', async (t) => {
  await openMenu(t, { sessionId: '', mode: 'swarm' });
  assert.deepEqual(rows(), ['ModelGPT-6 Sol', 'Reasoning effortExtra High']);
  assert.equal(document.querySelector('.route-sheet-separator'), null);
});
