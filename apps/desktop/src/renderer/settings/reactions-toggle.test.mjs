import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { applySectionRefresh, refreshCapabilitySections } from './capability-data.ts';
import { BotsPanel } from './desktop-pet-toggle.tsx';
import { t as translate } from '../i18n.ts';

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'PointerEvent', 'Event', 'KeyboardEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = new Proxy({}, { get: () => async () => undefined });
  const runs = [];
  const run = async (name, args) => runs.push([name, args]);
  const render = (data, pending = '') =>
    act(async () =>
      root.render(React.createElement(BotsPanel, { data, pending, run, api: dom.window.mixdogDesktop }))
    );
  const switchNamed = (name) => dom.window.document.querySelector(`input[aria-label="${translate(name)}"]`);
  return { render, toggle: () => switchNamed('Reactions'), switchNamed, runs, document: dom.window.document };
}

test('the Reactions switch sits right after Regular check-ins, reads getReactionSettings and writes setReactionsEnabled', async (t) => {
  const { render, toggle, switchNamed, runs, document } = mount(t);
  const requests = [];
  const api = {
    readCapabilities: async (batch) => {
      requests.push(...batch);
      return batch.map(() => ({ ok: true, value: { reactions: false } }));
    },
  };
  const data = applySectionRefresh({}, await refreshCapabilitySections(api, ['reactions']));
  assert.deepEqual(requests, [{ capability: 'getReactionSettings', args: [] }]);
  await render(data);
  const switches = [...document.querySelectorAll('input[aria-label]')].map((input) => input.getAttribute('aria-label'));
  const at = switches.indexOf(translate('Regular check-ins'));
  assert.equal(switches[at + 1], translate('Reactions'));
  assert.ok(switchNamed('Regular check-ins'));
  assert.equal(toggle().checked, false);
  await act(async () => toggle().click());
  assert.deepEqual(runs, [['setReactionsEnabled', [true]]]);
  await render({ reactions: { reactions: true } });
  assert.equal(toggle().checked, true);
  await act(async () => toggle().click());
  assert.deepEqual(runs.at(-1), ['setReactionsEnabled', [false]]);
});

test('the Reactions switch reads on before the setting has loaded', async (t) => {
  const { render, toggle } = mount(t);
  await render({});
  assert.equal(toggle().checked, true);
});
