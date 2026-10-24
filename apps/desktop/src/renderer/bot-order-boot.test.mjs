// A phone pays every relay round trip: the bots lists that mount at boot (the
// Bots page, the Sessions bot section, each remount) share ONE getBotOrder read,
// and a settings change rereads once for all of them.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { resetBotOrder, useBotOrder } from './bot-order-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ label }) {
  return React.createElement('output', { 'data-probe': label }, useBotOrder().join(','));
}

function boot(t) {
  resetBotOrder();
  const { root, dom } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  t.after(() => resetBotOrder());
  const listeners = new Set();
  const asked = [];
  dom.window.mixdogDesktop = {
    invokeCapability: async ({ capability }) => {
      asked.push(capability);
      return { value: { order: ['b', 'a'] } };
    },
    subscribeSettingsChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { root, dom, asked, listeners };
}

const lists = (count) =>
  React.createElement(
    React.Fragment,
    null,
    Array.from({ length: count }, (_, index) => React.createElement(Probe, { key: index, label: String(index) }))
  );

test('a boot with several bots lists reads getBotOrder once', async (t) => {
  const { root, asked, listeners } = boot(t);
  await act(async () => root.render(lists(3)));
  await act(async () => root.render(lists(5)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(asked, ['getBotOrder']);
  assert.deepEqual(
    [...document.querySelectorAll('[data-probe]')].map((node) => node.textContent),
    ['b,a', 'b,a', 'b,a', 'b,a', 'b,a']
  );
  assert.equal(listeners.size, 1, 'one settings subscription for every list');
});

test('the link becoming ready while the initial read is pending or done adds no second read', async (t) => {
  const { root, dom, asked } = boot(t);
  const gates = [];
  dom.window.mixdogDesktop.invokeCapability = ({ capability }) => {
    asked.push(capability);
    return new Promise((resolve) => gates.push(resolve));
  };
  const fire = (name) => act(async () => dom.window.dispatchEvent(new dom.window.Event(name)));
  await act(async () => root.render(lists(2)));
  assert.equal(asked.length, 1);
  await fire('mixdog:remote-connection-ready');
  assert.equal(asked.length, 1, 'readiness joins the pending initial read');
  await act(async () => gates[0]({ value: { order: ['b', 'a'] } }));
  await fire('mixdog:remote-connection-ready');
  assert.equal(asked.length, 1, 'readiness after the read adopts it');
  assert.equal(document.querySelector('[data-probe]').textContent, 'b,a');
});

test('a reconnect invalidates the read and rereads once', async (t) => {
  const { root, dom, asked } = boot(t);
  const fire = (name) => act(async () => dom.window.dispatchEvent(new dom.window.Event(name)));
  await act(async () => root.render(lists(2)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await fire('mixdog:remote-connection-ready');
  assert.equal(asked.length, 1);
  await fire('mixdog:remote-reconnected');
  assert.equal(asked.length, 2, 'a returning link invalidates the read');
});

test('the last list leaving retires a pending read: its late answer neither publishes nor fills the cache', async (t) => {
  const { root, dom } = boot(t);
  const gates = [];
  const asked = [];
  dom.window.mixdogDesktop.invokeCapability = ({ capability }) => {
    asked.push(capability);
    return new Promise((resolve) => gates.push(resolve));
  };
  await act(async () => root.render(lists(2)));
  assert.equal(asked.length, 1);
  await act(async () => root.render(null));
  // The retired read answers after every list is gone.
  await act(async () => gates[0]({ value: { order: ['late'] } }));
  await act(async () => root.render(lists(1)));
  assert.equal(asked.length, 2, 'the remount reads afresh instead of adopting the retired read');
  assert.equal(document.querySelector('[data-probe]').textContent, '', 'the late answer was not published');
  await act(async () => gates[1]({ value: { order: ['fresh'] } }));
  assert.equal(document.querySelector('[data-probe]').textContent, 'fresh');
});

test('a settings change rereads once for all lists, and a list that mounts later adopts the cached order', async (t) => {
  const { root, asked, listeners } = boot(t);
  await act(async () => root.render(lists(3)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => {
    for (const listener of [...listeners]) listener({ scope: 'desktop' });
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(asked.length, 2);
  await act(async () => root.render(lists(4)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(asked.length, 2);
  // With no list left nothing hears changes: the next one reads afresh.
  await act(async () => root.render(null));
  assert.equal(listeners.size, 0);
  await act(async () => root.render(lists(1)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(asked.length, 3);
});
