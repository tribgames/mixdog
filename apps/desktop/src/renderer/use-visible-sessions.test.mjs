import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { currentVisibleSessionIds, useVisibleSessions } from './use-visible-sessions.ts';

test('the next tab registers before a slow old tab settles and retired failures cannot retry', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  const calls = [];
  const old = Promise.withResolvers();
  const timers = new Map();
  let sequence = 0;
  dom.window.setTimeout = (callback) => {
    timers.set(++sequence, callback);
    return sequence;
  };
  dom.window.clearTimeout = (id) => timers.delete(id);
  dom.window.mixdogDesktop = {
    setVisibleSessions: (ids) => {
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
    restore();
  }
});

test('a removed instance withdraws only its own registration, never its replacement', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  const calls = [];
  dom.window.mixdogDesktop = {
    setVisibleSessions: (ids) => {
      calls.push(ids);
      return Promise.resolve(true);
    },
  };
  function Pane({ ids }) {
    useVisibleSessions(ids);
    return null;
  }
  const panes = (...entries) =>
    React.createElement(
      React.Fragment,
      null,
      entries.map(([key, ids]) => React.createElement(Pane, { key, ids }))
    );
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(panes(['first', ['a']])));
    // A keyed remount: the replacement registers in its layout effect before the removed instance's passive cleanup runs.
    await act(async () => root.render(panes(['second', ['a']])));
    assert.deepEqual(calls.at(-1), ['a']);
    assert.deepEqual(currentVisibleSessionIds(), ['a']);
    await act(async () => root.render(panes(['second', ['a']], ['third', ['b']])));
    assert.deepEqual(calls.at(-1), ['b']);
    // The newest leaving hands the set to the instance still mounted.
    await act(async () => root.render(panes(['second', ['a']])));
    assert.deepEqual(calls.at(-1), ['a']);
    // An older instance leaving does not touch the newest one's registration.
    await act(async () => root.render(panes(['fourth', ['c']], ['second', ['a']])));
    assert.deepEqual(calls.at(-1), ['c']);
    const settled = calls.length;
    await act(async () => root.render(panes(['fourth', ['c']])));
    assert.equal(calls.length, settled);
    assert.deepEqual(currentVisibleSessionIds(), ['c']);
    await act(async () => root.unmount());
    assert.deepEqual(calls.at(-1), []);
    assert.deepEqual(currentVisibleSessionIds(), []);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
