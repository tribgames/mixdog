import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ConnectorSwitchList, prefetchConnectorSwitches } = await import('./connector-switches.tsx');

/** A host whose connector reads the test answers by hand; writes answer at once. */
function slowHost() {
  const reads = [];
  const api = {
    invokeCapability: ({ capability, args }) => {
      if (capability === 'getAgentConnectors') {
        const answer = Promise.withResolvers();
        reads.push(answer);
        return answer.promise;
      }
      return Promise.resolve({ value: [{ id: args[1], enabled: args[2] }] });
    },
  };
  return { api, reads };
}
const flush = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const gmail = (enabled) => ({ value: [{ id: 'gmail', enabled }] });

test("a warm-up's read in flight is the mounted list's read: the host is asked once", async () => {
  const { api, reads } = slowHost();
  const warm = prefetchConnectorSwitches(api, 'agent', 'shared-bot');
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(ConnectorSwitchList, { api, kind: 'agent', target: 'shared-bot' }))
  );
  assert.equal(reads.length, 1);
  reads[0].resolve(gmail(true));
  await warm;
  await flush();
  assert.equal(document.querySelector('input[type="checkbox"]').checked, true);
  await act(async () => root.unmount());
});

test('an activation read that answers after a toggle never puts the old switch back', async () => {
  const { api, reads } = slowHost();
  const warm = prefetchConnectorSwitches(api, 'agent', 'ordered-bot');
  reads[0].resolve(gmail(true));
  await warm;
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(ConnectorSwitchList, { api, kind: 'agent', target: 'ordered-bot' }))
  );
  const input = () => document.querySelector('input[type="checkbox"]');
  assert.equal(input().checked, true, 'the cached switches paint in the first frame');
  assert.equal(reads.length, 2, 'the activation revalidates behind them');
  await act(async () => input().click());
  await flush();
  assert.equal(input().checked, false);
  // The revalidation began before the toggle and answers after it.
  reads[1].resolve(gmail(true));
  await flush();
  assert.equal(input().checked, false, 'the older answer is dropped');
  await act(async () => root.unmount());
});

test('a connector changed elsewhere updates the open list on the settings-changed broadcast', async () => {
  const { api, reads } = slowHost();
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(ConnectorSwitchList, { api, kind: 'agent', target: 'external-bot' }))
  );
  reads[0].resolve(gmail(true));
  await flush();
  const names = () =>
    [...document.querySelectorAll('[data-connector-switch]')].map((row) => row.dataset.connectorSwitch);
  assert.deepEqual(names(), ['gmail']);
  // Another window switches gmail off and installs Slack; the host announces it.
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('mixdog:setup-changed', { detail: { action: 'settings_changed' } }));
  });
  assert.equal(reads.length, 2, 'the open list reads again');
  reads[1].resolve({
    value: [
      { id: 'gmail', enabled: false },
      { id: 'slack', enabled: true },
    ],
  });
  await flush();
  assert.deepEqual(names(), ['gmail', 'slack']);
  assert.equal(document.querySelector('[data-connector-switch="gmail"] input').checked, false);
  await act(async () => root.unmount());
});
