import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { applySectionRefresh, refreshCapabilitySections } from './capability-data.ts';
import { GeneralPanel } from './general-panel.tsx';
import { t as translate } from '../i18n.ts';

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'PointerEvent', 'Event', 'KeyboardEvent'],
    rootId: 'root',
  });
  const api = new Proxy({}, { get: () => async () => undefined });
  dom.window.mixdogDesktop = api;
  const runs = [];
  const run = async (name, args) => runs.push([name, args]);
  const render = (data, pending = '') =>
    act(async () => root.render(React.createElement(GeneralPanel, { data, pending, run, api })));
  const toggle = () => dom.window.document.querySelector(`input[aria-label="${translate('Regular check-ins')}"]`);
  return { render, toggle, runs };
}

/** The settings data the panel gets for the heartbeat section: the real section
 *  read (SECTION_READS) answered by a fake capability host that stores the setting. */
async function loadedData(stored) {
  const requests = [];
  const api = {
    readCapabilities: async (batch) => {
      requests.push(...batch);
      return batch.map(() => ({ ok: true, value: { heartbeat: stored } }));
    },
  };
  const landed = await refreshCapabilitySections(api, ['heartbeat']);
  return { data: applySectionRefresh({}, landed), requests };
}

test('the Regular check-ins switch reads data.heartbeat.heartbeat (from getHeartbeatSettings) and writes setHeartbeatEnabled', async (t) => {
  const { render, toggle, runs } = mount(t);
  const off = await loadedData(false);
  assert.deepEqual(off.requests, [{ capability: 'getHeartbeatSettings', args: [] }], 'the section read is the getter');
  assert.deepEqual(off.data.heartbeat, { heartbeat: false });
  await render(off.data);
  assert.equal(toggle().checked, false);
  await act(async () => toggle().click());
  assert.deepEqual(runs, [['setHeartbeatEnabled', [true]]]);

  const on = await loadedData(true);
  await render(on.data);
  assert.equal(toggle().checked, true);
  await act(async () => toggle().click());
  assert.deepEqual(runs.at(-1), ['setHeartbeatEnabled', [false]]);
  assert.equal(runs.length, 2);
});

test('the switch reads on before the setting has loaded, and cannot be flipped while another write is pending', async (t) => {
  const { render, toggle, runs } = mount(t);
  await render({});
  assert.equal(toggle().checked, true, 'the default is on');
  await render({ heartbeat: { heartbeat: false } }, 'setRecapEnabled');
  assert.equal(toggle().checked, false);
  assert.equal(toggle().disabled, true);
  await act(async () => toggle().click());
  assert.deepEqual(runs, []);
});
