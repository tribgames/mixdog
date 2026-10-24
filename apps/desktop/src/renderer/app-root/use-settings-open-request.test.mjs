import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { announceDrawerDismiss } from '../drawer-intent.ts';
import { useSettingsOpenRequest } from './use-settings-open-request.ts';

installTestDom(null, { expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'] });

/** A settings module whose import the test finishes by hand. */
function slowModule() {
  const gate = Promise.withResolvers();
  let loaded = null;
  return {
    peek: () => loaded,
    load: () => gate.promise.then(() => loaded),
    finish: () => {
      loaded = {};
      gate.resolve();
    },
    fail: () => gate.reject(new Error('chunk failed')),
  };
}

async function mount(module, initial = { settingsOpen: false }) {
  let api;
  const opened = [];
  function Harness(props) {
    api = useSettingsOpenRequest({ module, waits: () => true, ...props });
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  const render = (props) => act(async () => root.render(React.createElement(Harness, props)));
  await render(initial);
  return {
    opened,
    tap: (name) => api.request(() => opened.push(name)),
    cancel: () => api.cancel(),
    render,
    unmount: () => act(async () => root.unmount()),
  };
}

const settleImport = (module) =>
  act(async () => {
    module.finish();
    await new Promise((resolve) => setImmediate(resolve));
  });

test('a tap before the module loads opens once it has, not before', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  assert.deepEqual(view.opened, []);
  await settleImport(module);
  assert.deepEqual(view.opened, ['settings']);
  await view.unmount();
});

test('with the module loaded a tap opens at once', async () => {
  const module = slowModule();
  const view = await mount(module);
  await settleImport(module);
  view.tap('settings');
  assert.deepEqual(view.opened, ['settings']);
  await view.unmount();
});

test('repeated taps while loading open once, on the newest destination', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  view.tap('settings');
  view.tap('providers');
  await settleImport(module);
  assert.deepEqual(view.opened, ['providers']);
  await view.unmount();
});

test('asking the drawer to close drops the pending open before the closed state commits', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  // The phone commits a close as a transition behind the dismissal: the import
  // lands after the request and before any render shows the drawer closed.
  announceDrawerDismiss();
  await settleImport(module);
  assert.deepEqual(view.opened, []);
  // The next tap is a fresh request, not a leftover.
  view.tap('settings');
  assert.deepEqual(view.opened, ['settings']);
  await view.unmount();
});

test('a dismissal after the pending open ran touches nothing', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  await settleImport(module);
  announceDrawerDismiss();
  assert.deepEqual(view.opened, ['settings']);
  await view.unmount();
});

test('another navigation drops the pending open', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  view.cancel();
  await settleImport(module);
  assert.deepEqual(view.opened, []);
  await view.unmount();
});

test('Settings opened by another route drops the pending open', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  await view.render({ settingsOpen: true });
  await settleImport(module);
  assert.deepEqual(view.opened, []);
  await view.unmount();
});

test('a tap after a cancelled one is its own request', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('first');
  view.cancel();
  view.tap('second');
  await settleImport(module);
  assert.deepEqual(view.opened, ['second']);
  await view.unmount();
});

test('a failed import still opens, so the dialog reports it', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  await act(async () => {
    module.fail();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(view.opened, ['settings']);
  await view.unmount();
});

test('unmounting drops the pending open', async () => {
  const module = slowModule();
  const view = await mount(module);
  view.tap('settings');
  await view.unmount();
  await settleImport(module);
  assert.deepEqual(view.opened, []);
});
