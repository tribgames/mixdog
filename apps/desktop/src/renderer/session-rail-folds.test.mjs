import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Element', 'HTMLElement', 'Event'],
});

const { useSessionRailFolds } = await import('./session-rail-folds.ts');
const KEY = 'mixdog.desktop.session-rail-folds.v2';

async function mount(sessionId) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const latest = {};
  function Probe() {
    Object.assign(latest, useSessionRailFolds(sessionId));
    return null;
  }
  await act(async () => root.render(React.createElement(Probe)));
  return { latest, unmount: () => act(async () => root.unmount()) };
}

test('a viewed session with no folds stores nothing; stale agent groups leave when groups are written', async () => {
  window.localStorage.removeItem(KEY);
  const view = await mount('viewed');
  assert.equal(view.latest.groupOpen('agents:x', true), true);
  assert.equal(window.localStorage.getItem(KEY), null, 'viewing writes nothing');
  await act(async () => view.latest.setGroups({ 'agents:a': false, 'agents:gone': false }));
  await act(async () =>
    view.latest.setGroups({ 'agents:b': false }, { prefix: 'agents:', keys: ['agents:a', 'agents:b'] })
  );
  const stored = JSON.parse(window.localStorage.getItem(KEY)).viewed.groups;
  assert.deepEqual(Object.keys(stored).sort(), ['agents:a', 'agents:b']);
  await view.unmount();
});

test('folds that could not be stored are read back from memory', async () => {
  const original = window.localStorage.setItem.bind(window.localStorage);
  Object.defineProperty(window.localStorage, 'setItem', {
    configurable: true,
    value: () => {
      throw new Error('quota');
    },
  });
  try {
    const view = await mount('unwritable');
    await act(async () => view.latest.setGroups({ done: true }));
    assert.equal(view.latest.groupOpen('done', false), true);
    await view.unmount();
  } finally {
    Object.defineProperty(window.localStorage, 'setItem', { configurable: true, value: original });
  }
});
