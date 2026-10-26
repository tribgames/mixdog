import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { HeartbeatSwitch } from './agent-heartbeat-switch.tsx';
import { t as translate } from './i18n.ts';
import { announceSetupChange } from './setup-change-refresh.ts';
import { invalidateCapabilitySettings } from './settings/capability-data.ts';

const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

function mount(t, stored) {
  const { dom, root } = installTestDom(t, {
    expose: [
      'HTMLElement',
      'HTMLInputElement',
      'Element',
      'Node',
      'MouseEvent',
      'Event',
      'KeyboardEvent',
      'CustomEvent',
    ],
    rootId: 'root',
  });
  const calls = [];
  const api = {
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, args]);
      if (capability === 'getHeartbeatSettings') return { ok: true, value: { heartbeat: stored.value } };
      if (capability === 'setHeartbeatEnabled') stored.value = args[0];
      return { ok: true };
    },
  };
  const render = (active = true) => act(async () => root.render(React.createElement(HeartbeatSwitch, { api, active })));
  const toggle = () => dom.window.document.querySelector(`input[aria-label="${translate('Regular check-ins')}"]`);
  return { render, toggle, calls };
}

test("the representative bot's profile reads and writes the global check-ins setting", async (t) => {
  const stored = { value: false };
  const view = mount(t, stored);
  await view.render();
  await settle();
  assert.equal(view.toggle().checked, false, 'it shows the stored setting');
  await act(async () => view.toggle().click());
  await settle();
  assert.deepEqual(view.calls.at(-1), ['setHeartbeatEnabled', [true]]);
  assert.equal(view.toggle().checked, true);
});

test('an open profile follows the switch when Settings changes it', async (t) => {
  const stored = { value: true };
  const view = mount(t, stored);
  await view.render();
  await settle();
  assert.equal(view.toggle().checked, true);
  stored.value = false;
  invalidateCapabilitySettings({}, 'setHeartbeatEnabled');
  await settle();
  assert.equal(view.toggle().checked, false);
});

function mountDeferred(t) {
  const { dom, root } = installTestDom(t, {
    expose: [
      'HTMLElement',
      'HTMLInputElement',
      'Element',
      'Node',
      'MouseEvent',
      'Event',
      'KeyboardEvent',
      'CustomEvent',
    ],
    rootId: 'root',
  });
  const pending = [];
  const api = {
    invokeCapability: ({ capability }) => {
      if (capability !== 'getHeartbeatSettings') return Promise.resolve({ ok: true });
      return new Promise((resolve) => pending.push((value) => resolve({ ok: true, value: { heartbeat: value } })));
    },
  };
  const toggle = () => dom.window.document.querySelector(`input[aria-label="${translate('Regular check-ins')}"]`);
  const render = () => act(async () => root.render(React.createElement(HeartbeatSwitch, { api, active: true })));
  return { render, toggle, pending };
}

test('an older read resolving last never overwrites the newer value', async (t) => {
  const view = mountDeferred(t);
  await view.render();
  invalidateCapabilitySettings({}, 'setHeartbeatEnabled');
  assert.equal(view.pending.length, 2);
  await act(async () => view.pending[1](false));
  await act(async () => view.pending[0](true));
  await settle();
  assert.equal(view.toggle().checked, false);
});

test('a change announced from elsewhere (setup-change broadcast) re-reads the setting', async (t) => {
  const stored = { value: true };
  const view = mount(t, stored);
  await view.render();
  await settle();
  stored.value = false;
  await act(async () => announceSetupChange('settings_changed'));
  await settle();
  assert.equal(view.toggle().checked, false);
});

test('a hidden profile reads nothing; showing it again reads the setting changed elsewhere', async (t) => {
  const stored = { value: true };
  const view = mount(t, stored);
  await view.render(false);
  assert.deepEqual(view.calls, []);
  stored.value = false;
  await view.render(true);
  await settle();
  assert.equal(view.toggle().checked, false);
});
