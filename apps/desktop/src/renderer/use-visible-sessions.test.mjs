import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useVisibleSessions } from './use-visible-sessions.ts';

test('the next tab registers before a slow old tab settles and retired failures cannot retry', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const prior = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  const calls = [];
  const old = Promise.withResolvers();
  const timers = new Map();
  let sequence = 0;
  dom.window.setTimeout = callback => { timers.set(++sequence, callback); return sequence; };
  dom.window.clearTimeout = id => timers.delete(id);
  dom.window.mixdogDesktop = {
    setVisibleSessions: ids => {
      calls.push(ids);
      return ids[0] === 'old' ? old.promise : Promise.resolve(true);
    },
  };
  function Pane({ ids }) {
    useVisibleSessions(ids);
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(Pane, { ids: ['old'] })));
    await act(async () => root.render(React.createElement(Pane, { ids: ['current'] })));
    assert.deepEqual(calls, [['old'], ['current']]);
    await act(async () => old.reject(new Error('old subscription timed out')));
    assert.equal(timers.size, 0);
    await act(async () => root.unmount());
    assert.deepEqual(calls, [['old'], ['current'], []]);
  } finally {
    old.resolve(true);
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
