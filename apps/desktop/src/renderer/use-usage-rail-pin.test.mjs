// A pin toggle persists exactly once. Persistence used to run inside the state
// updater, which React re-invokes under StrictMode, so one click wrote the
// setting twice.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useRef } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'Node', 'HTMLElement', 'Event', 'localStorage'],
});
after(restore);

const { createRoot } = await import('react-dom/client');
const { useUsageRailPin } = await import('./use-usage-rail-pin.ts');

test('one usage pin toggle writes the setting once, even under StrictMode', async (t) => {
  const writes = [];
  window.mixdogDesktop = {
    async readSettings() {
      return { usagePinned: false };
    },
    updateSetting(key, value) {
      writes.push([key, value]);
      return Promise.resolve();
    },
  };
  let state;
  function Probe() {
    const rail = useRef(null);
    const nav = useRef(null);
    const settings = useRef(null);
    state = useUsageRailPin(
      { dashboard: {}, status: 'ready', loading: false, refreshedAt: 1 },
      { rail, nav, settings },
      true
    );
    return React.createElement('aside', { ref: rail });
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop;
  });
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))));
  await act(async () => state.toggleUsagePin());

  assert.equal(state.usagePinned, true);
  assert.deepEqual(writes, [['usagePinned', true]]);
  assert.equal(window.localStorage.getItem('mixdog.desktop.usage-rail-pin.v1'), null);
});
