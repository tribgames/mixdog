import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { subscribeSetupChanges, useSetupChangeAnnouncer } from './setup-change-refresh.ts';

async function mountAnnouncer(t) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
    actEnvironment: false,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const counter = { announced: 0 };
  const unsubscribe = subscribeSetupChanges(() => {
    counter.announced += 1;
  });
  let laneListener = null;
  const subscribeSessionLanes = (listener) => {
    laneListener = listener;
    return () => {};
  };
  let change = null;
  function Harness() {
    useSetupChangeAnnouncer(change, 's1', subscribeSessionLanes);
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    unsubscribe();
    await act(async () => root.unmount());
    restore();
  });
  return {
    counter,
    render: async (next) => {
      change = next;
      await act(async () => root.render(React.createElement(Harness)));
    },
    lane: (sessionId, setupChanged) => laneListener({ sessionId, snapshot: { setupChanged } }),
  };
}

test('each new App-snapshot setup change announces once', async (t) => {
  const { counter, render } = await mountAnnouncer(t);
  await render(null);
  assert.equal(counter.announced, 0);
  await render({ action: 'save_project', seq: 1, at: Date.now() });
  assert.equal(counter.announced, 1);
  await render({ action: 'save_project', seq: 1, at: Date.now() });
  assert.equal(counter.announced, 1, 'a re-render of the same change does not announce again');
  await render({ action: 'save_project', seq: 2, at: Date.now() });
  assert.equal(counter.announced, 2);
});

test('a change arriving on a session lane announces once, per session', async (t) => {
  const { counter, render, lane } = await mountAnnouncer(t);
  await render({ action: 'save_project', seq: 2, at: Date.now() });
  assert.equal(counter.announced, 1);
  lane('s1', { action: 'save_project', seq: 2, at: Date.now() });
  assert.equal(counter.announced, 1, 'the same change arriving on the lane is already announced');
  lane('s2', { action: 'set_route', seq: 1, at: Date.now() });
  assert.equal(counter.announced, 2);
});

test('a replayed change older than the TTL is history', async (t) => {
  const { counter, render, lane } = await mountAnnouncer(t);
  await render(null);
  lane('s3', { action: 'set_route', seq: 1, at: Date.now() - 60_000 });
  assert.equal(counter.announced, 0);
});

test("a runtime's settings-changed announcement is left to the host event, never once per lane", async (t) => {
  const { counter, render, lane } = await mountAnnouncer(t);
  await render(null);
  lane('s4', { action: 'settings_changed', seq: 1, at: Date.now() });
  await render({ action: 'settings_changed', seq: 3, at: Date.now() });
  assert.equal(counter.announced, 0);
});

test('a permissions scope is a valid settings-changed broadcast', async () => {
  const { readSettingsChange } = await import('../shared/settings-changed.ts');
  assert.deepEqual(readSettingsChange({ scope: 'permissions' }), { scope: 'permissions' });
  assert.deepEqual(readSettingsChange({ scope: 'agent' }), { scope: 'agent' });
  assert.equal(readSettingsChange({ scope: 'other' }), null);
});
