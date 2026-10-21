import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { GeneralPanel } from './general-panel.tsx';
import { t as translate } from '../i18n.ts';

function mount(t, toolModules, run) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'PointerEvent', 'Event', 'KeyboardEvent'],
    rootId: 'root',
  });
  const api = new Proxy({}, { get: () => async () => undefined });
  dom.window.mixdogDesktop = api;
  const render = (modules) =>
    act(async () =>
      root.render(React.createElement(GeneralPanel, { data: { toolModules: modules }, pending: '', run, api }))
    );
  return { document: dom.window.document, render };
}

const select = (document) => document.querySelector(`button[aria-label="${translate('Auto reasoning base')}"]`);

test('the Auto reasoning base select reads the setting (default Medium) and saves a pick', async (t) => {
  const calls = [];
  const { document, render } = mount(t, {}, async (name, args) => calls.push([name, args]));
  await render({});
  assert.equal(select(document).textContent, translate('Medium'));
  await render({ autoEffortBase: 'high' });
  assert.equal(select(document).textContent, translate('High'));
  await act(async () => select(document).click());
  const items = [...document.querySelectorAll('[role="option"]')];
  assert.deepEqual(
    items.map((node) => node.textContent),
    ['Low', 'Medium', 'High'].map((l) => translate(l))
  );
  await act(async () => items[0].click());
  assert.deepEqual(calls, [['setAutoEffortBase', ['low']]]);
});
