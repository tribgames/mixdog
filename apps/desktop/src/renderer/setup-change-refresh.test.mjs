import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { subscribeSetupChanges, useSetupChangeAnnouncer } from './setup-change-refresh.ts';

test('each new setup change announces once, from the App snapshot or a session lane', async () => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
    actEnvironment: false,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let announced = 0;
  const unsubscribe = subscribeSetupChanges(() => {
    announced += 1;
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
  const render = async (next) => {
    change = next;
    await act(async () => root.render(React.createElement(Harness)));
  };

  await render(null);
  assert.equal(announced, 0);
  await render({ action: 'save_project', seq: 1, at: Date.now() });
  assert.equal(announced, 1);
  await render({ action: 'save_project', seq: 1, at: Date.now() });
  assert.equal(announced, 1, 'a re-render of the same change does not announce again');
  await render({ action: 'save_project', seq: 2, at: Date.now() });
  assert.equal(announced, 2);

  laneListener({ sessionId: 's1', snapshot: { setupChanged: { action: 'save_project', seq: 2, at: Date.now() } } });
  assert.equal(announced, 2, 'the same change arriving on the lane is already announced');
  laneListener({ sessionId: 's2', snapshot: { setupChanged: { action: 'set_route', seq: 1, at: Date.now() } } });
  assert.equal(announced, 3);
  laneListener({
    sessionId: 's3',
    snapshot: { setupChanged: { action: 'set_route', seq: 1, at: Date.now() - 60_000 } },
  });
  assert.equal(announced, 3, 'a replayed change older than the TTL is history');

  unsubscribe();
  await act(async () => root.unmount());
});
