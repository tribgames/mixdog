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
  const api = new Proxy({}, { get: () => async () => undefined });
  dom.window.mixdogDesktop = api;
  const runs = [];
  const run = async (name, args) => runs.push([name, args]);
  const render = (data, pending = '') =>
    act(async () => root.render(React.createElement(BotsPanel, { data, pending, run, api })));
  const toggle = () => dom.window.document.querySelector(`input[aria-label="${translate('Regular check-ins')}"]`);
  return { render, toggle, runs, document: dom.window.document, window: dom.window };
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

test('the Check-in interval select shows the stored choice, offers 30 min / 1 h / 2 h / 4 h, and writes setHeartbeatInterval', async (t) => {
  const { render, runs, document, window } = mount(t);
  const doc = () => document;
  const picker = () => doc().querySelector(`[aria-label="${translate('Check-in interval')}"]`);
  const options = () => [...doc().querySelectorAll('[role="option"]')].map((o) => o.textContent.trim());
  // Not yet loaded, or a value outside the choices: the default, an hour.
  await render({});
  assert.equal(picker().textContent.trim(), translate('1 hour'));
  await render({ heartbeat: { heartbeat: true, intervalMinutes: 7 } });
  assert.equal(picker().textContent.trim(), translate('1 hour'));
  await render({ heartbeat: { heartbeat: true, intervalMinutes: 240 } });
  assert.equal(picker().textContent.trim(), translate('4 hours'));
  await act(async () => picker().click());
  assert.deepEqual(options(), [
    translate('30 minutes'),
    translate('1 hour'),
    translate('2 hours'),
    translate('4 hours'),
  ]);
  const two = [...doc().querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === translate('2 hours'));
  await act(async () => two.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
  await act(async () => two.click());
  assert.deepEqual(runs, [['setHeartbeatInterval', [120]]]);
  // A write in flight blocks it, as the other rows.
  await render({ heartbeat: { heartbeat: true, intervalMinutes: 120 } }, 'setRecapEnabled');
  assert.equal(picker().disabled, true);
});
