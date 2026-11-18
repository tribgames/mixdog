import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useModelSelection } from './use-model-selection.ts';
import { createSessionLaneStore } from './session-lane-store.ts';

const decorator = { decorate: (snapshot) => snapshot, clear() {} };

/** The hook over a source the test paints (the session's stream) and a lane store the test feeds positions to. */
async function mounted(body) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { url: 'about:blank' },
  });
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  const store = createSessionLaneStore({ decorator });
  const root = createRoot(document.querySelector('main'));
  const control = {};
  function Harness() {
    const [source, setSource] = useState({ provider: 'openai', model: 'gpt-test', effort: 'high' });
    control.paint = setSource;
    const selection = useModelSelection('s', source, store);
    control.selection = selection;
    return React.createElement('span', null, `${selection.selection.effort}${selection.pending ? '…' : ''}`);
  }
  /** A lane publication of the session at feed seq `seq`. */
  const shown = (seq) =>
    act(async () => {
      store.apply({ sessionId: 's', frameSource: 'live', snapshot: { sessionId: 's', items: [{ id: `q${seq}`, role: 'user', text: 'x' }] }, streamPosition: { epoch: 'e', seq, order: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await body({ control, store, shown, text: () => document.querySelector('span').textContent });
  } finally {
    await act(async () => root.unmount());
    store.clear();
    dom.window.close();
  }
}

test('an answered pick is previewed until the stream shows the state its call produced, then the stream owns the value', async () => {
  await mounted(async ({ control, shown, text }) => {
    await shown(1);
    let token;
    await act(async () => (token = control.selection.begin({ provider: 'openai', model: 'gpt-test', effort: 'low' })));
    assert.equal(text(), 'low…', 'the pick previews while its call runs');
    // The call answered; its connection had received the mutation's notes up to seq 3.
    await act(async () => control.selection.settle(token, { epoch: 'e', seq: 3, order: 1 }));
    assert.equal(text(), 'low', 'answered, the preview stays until the stream reaches the mark');
    await shown(2);
    assert.equal(text(), 'low', 'a publication before the mark does not end it');
    // The stream reaches the mark showing a newer value another device set: that value shows, not the pick.
    await act(async () => control.paint({ provider: 'openai', model: 'gpt-test', effort: 'max' }));
    await shown(3);
    assert.equal(text(), 'max');
  });
});

test('a failed pick, or one with no stream to wait for, ends its preview at once', async () => {
  await mounted(async ({ control, text }) => {
    let token;
    await act(async () => (token = control.selection.begin({ provider: 'openai', model: 'gpt-test', effort: 'low' })));
    assert.equal(text(), 'low…');
    await act(async () => control.selection.settle(token, null));
    assert.equal(text(), 'high');
  });
});
