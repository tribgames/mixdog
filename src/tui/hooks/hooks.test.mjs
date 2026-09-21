import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import React, { act } from 'react';
import { render, Text } from 'ink';
import { useSharedTick } from './useSharedTick.mjs';
import { useSession } from './useSession.mjs';

const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
before(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
after(() => {
  if (previousActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

async function mount(element) {
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.rows = 20;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let frame = '';
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...args) => {
    frame = String(chunk);
    return write(chunk, ...args);
  };
  let view;
  await act(async () => {
    view = render(element, { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  });
  return {
    text: () => stripVTControlCharacters(frame).trim(),
    update: async (next) => {
      await act(async () => view.rerender(next));
    },
    close: async () => {
      await act(async () => view.unmount());
      stdin.end();
      stdout.end();
    },
  };
}

test('shared tick preserves independent cadence, fresh callbacks and unsubscribe cleanup', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const fast = [];
  const changed = [];
  const slow = [];
  const onFast = (now) => fast.push(now);
  const onChanged = (now) => changed.push(now);
  const onSlow = (now) => slow.push(now);
  function Probe({ active = true, callback = onFast }) {
    useSharedTick(130, active, callback);
    useSharedTick(500, true, onSlow);
    return React.createElement(Text, null, 'tick probe');
  }
  const view = await mount(React.createElement(Probe));
  try {
    context.mock.timers.tick(129);
    assert.deepEqual(fast, []);
    context.mock.timers.tick(1);
    context.mock.timers.tick(130);
    context.mock.timers.tick(130);
    assert.deepEqual(fast, [10130, 10260, 10390]);
    context.mock.timers.tick(110);
    assert.deepEqual(slow, [10500]);
    assert.deepEqual(fast, [10130, 10260, 10390]);
    context.mock.timers.tick(20);
    assert.deepEqual(fast, [10130, 10260, 10390, 10520]);

    context.mock.timers.tick(10);
    await view.update(React.createElement(Probe, { callback: onChanged }));
    context.mock.timers.tick(120);
    assert.deepEqual(changed, [10650]);
    await view.update(React.createElement(Probe, { active: false, callback: onChanged }));
    context.mock.timers.tick(350);
    assert.deepEqual(slow, [10500, 11000]);
    assert.deepEqual(changed, [10650]);
  } finally {
    await view.close();
  }
  context.mock.timers.tick(1000);
  assert.deepEqual(slow, [10500, 11000]);
  assert.deepEqual(changed, [10650]);
});

test('session snapshots update through the subscription and detach on unmount', async () => {
  let snapshot = { label: 'first snapshot' };
  const listeners = new Set();
  const store = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => snapshot,
  };
  function Probe() {
    return React.createElement(Text, null, useSession(store).label);
  }
  const view = await mount(React.createElement(Probe));
  try {
    assert.equal(view.text(), 'first snapshot');
    await act(async () => {
      snapshot = { label: 'second snapshot' };
      for (const listener of listeners) listener();
    });
    assert.equal(view.text(), 'second snapshot');
    assert.equal(listeners.size, 1);
  } finally {
    await view.close();
  }
  assert.equal(listeners.size, 0);
});
