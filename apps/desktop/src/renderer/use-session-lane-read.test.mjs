import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useSessionLaneRead } from './use-session-lane-read.ts';

for (const outcome of ['accepted-without-frame', 'pending', 'rejected', 'resume-owned']) {
  test(`cold pane exposes retry instead of waiting forever: ${outcome}`, async () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const prior = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) =>
      [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries({
      window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    })) Object.defineProperty(globalThis, key, { configurable: true, value });
    const timers = new Map();
    let timerId = 0;
    dom.window.setTimeout = (callback) => {
      timers.set(++timerId, callback);
      return timerId;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    let reads = 0;
    const read = () => {
      reads += 1;
      if (outcome === 'pending') return new Promise(() => {});
      if (outcome === 'rejected') return Promise.reject(new Error('session timeout'));
      return Promise.resolve(true);
    };
    function Pane({ hasLane = false, hidden = false, sessionId = 'restored' }) {
      const state = useSessionLaneRead({
        sessionId, hasLane, hidden, read, reconcileOnMount: outcome !== 'resume-owned',
      });
      return state.readUnavailable
        ? React.createElement('button', { onClick: state.retryRead }, 'Retry')
        : React.createElement('span', null, hasLane ? 'Transcript restored' : 'Loading');
    }
    const root = createRoot(document.getElementById('root'));
    const render = async (props = {}) => act(async () => root.render(React.createElement(Pane, props)));
    try {
      await render();
      assert.equal(reads, outcome === 'resume-owned' ? 0 : 1);
      await act(async () => { for (const callback of [...timers.values()]) callback(); });
      assert.equal(document.querySelector('button')?.textContent, 'Retry');
      await act(async () => document.querySelector('button').click());
      assert.equal(reads, outcome === 'resume-owned' ? 1 : 2);
      // A late lane still wins, even if its request never settled.
      await render({ hasLane: true });
      assert.equal(document.getElementById('root').textContent, 'Transcript restored');
      assert.equal(timers.size, 0);
      // Retired panes and drafts must not acquire a stale error.
      await render({ sessionId: 'other', hidden: true });
      assert.equal(document.querySelector('button'), null);
      assert.equal(timers.size, 0);
      await render({ sessionId: '' });
      assert.equal(document.querySelector('button'), null);
      assert.equal(timers.size, 0);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}
