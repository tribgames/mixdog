// A pin toggle persists exactly once. Persistence used to run inside the state
// updater, which React re-invokes under StrictMode, so one click wrote the
// setting twice.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useRef } from 'react';
import { JSDOM } from 'jsdom';

const DOM_GLOBALS = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Event', 'localStorage'];
const savedGlobals = DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
for (const key of DOM_GLOBALS)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

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
  assert.equal(window.localStorage.getItem('mixdog.desktop.usage-rail-pin.v1'), '1');
});
