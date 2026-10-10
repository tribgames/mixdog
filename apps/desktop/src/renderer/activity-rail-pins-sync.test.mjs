import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopSettingsStore } from '../main/settings-store.ts';
import { useActivityRailPins } from './use-activity-rail-pins.ts';
import { DESKTOP_TOAST_EVENT } from './desktop-toasts.tsx';
import { remoteConnectionInterruptedError } from './remote-connection-state.ts';
import { installTestDom } from './test-support/test-dom.mjs';

function hub() {
  let config = {};
  let tail = Promise.resolve();
  const store = new DesktopSettingsStore({
    loadConfig: async () => ({
      readConfig: () => config,
      updateConfigAsync: (update) => {
        const saved = tail.then(() => {
          config = update(config);
          return config;
        });
        tail = saved.catch(() => {});
        return saved;
      },
    }),
  });
  const listeners = new Map();
  const offline = new Set();
  const calls = [];
  let fail = false;
  let hold = false;
  let release;
  const api = (name) => ({
    readActivityRailPins: () => store.readActivityRailPins(),
    updateActivityRailPins: async (pins, initializeIfMissing = false) => {
      calls.push({ name, pins, initializeIfMissing });
      if (fail) {
        fail = false;
        throw new Error('pin config write rejected');
      }
      const saved = await store.updateActivityRailPins(pins, initializeIfMissing);
      for (const [client, callbacks] of listeners) {
        if (!offline.has(client)) for (const callback of callbacks) callback(saved);
      }
      if (hold && name === 'desktop' && !initializeIfMissing) {
        hold = false;
        return new Promise((resolve) => {
          release = () => resolve(saved);
        });
      }
      return saved;
    },
    subscribeActivityRailPins: (listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name).delete(listener);
    },
  });
  return {
    api,
    store,
    calls,
    offline,
    failNext: () => {
      fail = true;
    },
    holdNext: () => {
      hold = true;
    },
    release: () => release(),
  };
}

async function mount(t, shared, overrides = {}) {
  // Desktop no longer writes defaults back, so tests start from a saved order.
  if (!(await shared.store.readActivityRailPins())) await shared.store.updateActivityRailPins(['projects', 'sessions']);
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  window.localStorage.setItem('mixdog.desktop.activity-rail-pins.v1', '["projects","sessions"]');
  const root = createRoot(document.getElementById('root'));
  const values = {};
  const desktop = overrides.desktop ?? shared.api('desktop');
  const web = overrides.web ?? shared.api('web');
  function Client({ name, api, remote }) {
    values[name] = useActivityRailPins(api, remote);
    return React.createElement('output', { 'data-client': name }, JSON.stringify(values[name].pins));
  }
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Client, { name: 'desktop', api: desktop, remote: false }),
        React.createElement(Client, { name: 'web', api: web, remote: true })
      )
    )
  );
  return values;
}

test('only desktop seeds shared pins; both surfaces synchronize changes and recover missed pushes on reconnect', async (t) => {
  const shared = hub();
  const values = await mount(t, shared);
  assert.deepEqual(await shared.store.readActivityRailPins(), { pins: ['projects', 'sessions'], revision: 1 });
  assert.deepEqual(shared.calls, []);
  assert.deepEqual(values.web.pins, ['projects', 'sessions']);
  await act(async () => {
    values.desktop.savePins(['sessions', 'search']);
    values.desktop.savePins(['search', 'sessions', 'workflows']);
  });
  assert.deepEqual(values.desktop.pins, ['search', 'sessions', 'workflows']);
  assert.deepEqual(values.web.pins, ['search', 'sessions', 'workflows']);
  await act(async () => values.web.savePins([]));
  assert.deepEqual(values.desktop.pins, []);
  assert.deepEqual(values.web.pins, []);
  shared.offline.add('web');
  await act(async () => values.desktop.savePins(['projects', 'schedules']));
  assert.deepEqual(values.web.pins, []);
  shared.offline.delete('web');
  const writes = shared.calls.length;
  await act(async () => window.dispatchEvent(new window.Event('mixdog:remote-connection-ready')));
  assert.deepEqual(values.web.pins, ['projects', 'schedules']);
  assert.equal(shared.calls.length, writes, 'reconnect reads shared state without re-uploading a stale browser cache');
});

test('a delayed read or acknowledgement cannot replace the last saved order', async (t) => {
  const shared = hub();
  const old = await shared.store.updateActivityRailPins(['sessions']);
  const web = shared.api('web');
  const read = web.readActivityRailPins;
  let resolveRead;
  web.readActivityRailPins = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const values = await mount(t, shared, { web });
  await act(async () => values.desktop.savePins(['projects', 'search']));
  await act(async () => resolveRead(old));
  web.readActivityRailPins = read;
  assert.deepEqual(values.web.pins, ['projects', 'search']);
  shared.holdNext();
  await act(async () => values.desktop.savePins(['workflows', 'sessions']));
  await act(async () => values.web.savePins(['search', 'projects']));
  await act(async () => shared.release());
  assert.deepEqual(values.desktop.pins, ['search', 'projects']);
  assert.deepEqual(values.web.pins, ['search', 'projects']);
});

test('a rejected save restores the shared order and reports the error', async (t) => {
  const shared = hub();
  const values = await mount(t, shared);
  const toasts = [];
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));
  shared.failNext();
  await act(async () => values.web.savePins(['search']));
  assert.deepEqual(values.web.pins, ['projects', 'sessions']);
  assert.deepEqual(values.desktop.pins, ['projects', 'sessions']);
  assert.deepEqual((await shared.store.readActivityRailPins()).pins, ['projects', 'sessions']);
  assert.equal(toasts.at(-1).tone, 'error');
  assert.match(toasts.at(-1).text, /pin config write rejected/);
});

test('an interrupted read stays quiet and the next connection reads the shared order', async (t) => {
  const shared = hub();
  await shared.store.updateActivityRailPins(['search', 'workflows']);
  const web = shared.api('web');
  const read = web.readActivityRailPins;
  let interrupt;
  web.readActivityRailPins = () =>
    new Promise((_, reject) => {
      interrupt = () => reject(remoteConnectionInterruptedError());
    });
  const values = await mount(t, shared, { web });
  const toasts = [];
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));
  await act(async () => interrupt());
  assert.deepEqual(toasts, []);
  web.readActivityRailPins = read;
  await act(async () => window.dispatchEvent(new window.Event('mixdog:remote-connection-ready')));
  assert.deepEqual(values.web.pins, ['search', 'workflows']);
});

test('an interrupted save restores the shared order and asks to check the connection', async (t) => {
  const shared = hub();
  const web = shared.api('web');
  web.updateActivityRailPins = async () => {
    throw remoteConnectionInterruptedError();
  };
  const values = await mount(t, shared, { web });
  const toasts = [];
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail));
  await act(async () => values.web.savePins(['search']));
  assert.deepEqual(values.web.pins, ['projects', 'sessions']);
  assert.equal(toasts.at(-1).tone, 'error');
  assert.equal(toasts.at(-1).text, 'Sidebar: Check the connection, then try again.');
});

test('a successful read with nothing stored means the host default for remote clients too', async (t) => {
  const shared = hub();
  const web = { ...shared.api('web'), readActivityRailPins: async () => null };
  const values = await mount(t, shared, { web });
  assert.deepEqual(values.web.pins, ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions']);
});

const DEFAULT_PINS = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions'];

test('a failed save after an absent read rolls back to the default list', async (t) => {
  const shared = hub();
  const web = {
    ...shared.api('web'),
    readActivityRailPins: async () => null,
    updateActivityRailPins: async () => {
      throw new Error('pin config write rejected');
    },
  };
  const values = await mount(t, shared, { web });
  assert.deepEqual(values.web.pins, DEFAULT_PINS);
  await act(async () => values.web.savePins(['search']));
  assert.deepEqual(values.web.pins, DEFAULT_PINS);
});

test('after an absent read a lower host revision is accepted', async (t) => {
  const shared = hub();
  let push;
  let stored = { pins: ['search'], revision: 5 };
  const web = {
    ...shared.api('web'),
    readActivityRailPins: async () => stored,
    subscribeActivityRailPins: (listener) => {
      push = listener;
      return () => {};
    },
  };
  const values = await mount(t, shared, { web });
  assert.deepEqual(values.web.pins, ['search']);
  stored = null;
  await act(async () => window.dispatchEvent(new window.Event('mixdog:remote-connection-ready')));
  assert.deepEqual(values.web.pins, DEFAULT_PINS);
  await act(async () => push({ pins: ['workflows'], revision: 1 }));
  assert.deepEqual(values.web.pins, ['workflows']);
});

test('an absent read does not clobber a pending write', async (t) => {
  const shared = hub();
  let resolveRead;
  const web = shared.api('web');
  web.readActivityRailPins = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const values = await mount(t, shared, { web });
  await act(async () => values.web.savePins(['search']));
  await act(async () => resolveRead(null));
  assert.deepEqual(values.web.pins, ['search']);
});

test('an absent read older than a subscription update does not reset the confirmed revision', async (t) => {
  const shared = hub();
  let push;
  let resolveRead;
  const web = {
    ...shared.api('web'),
    readActivityRailPins: () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    subscribeActivityRailPins: (listener) => {
      push = listener;
      return () => {};
    },
  };
  const values = await mount(t, shared, { web });
  await act(async () => push({ pins: ['search'], revision: 5 }));
  await act(async () => resolveRead(null));
  assert.deepEqual(values.web.pins, ['search']);
  await act(async () => push({ pins: ['workflows'], revision: 4 }));
  assert.deepEqual(values.web.pins, ['search']);
});
