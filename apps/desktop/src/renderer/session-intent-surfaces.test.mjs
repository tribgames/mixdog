import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Element', 'HTMLElement', 'MouseEvent', 'FocusEvent', 'Event', 'CustomEvent', 'navigator'],
});
test.after(restore);
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver ??= window.MutationObserver;

const { WorkspaceTabStrip } = await import('./WorkspaceTabStrip.tsx');
const { useSessionPrefetch } = await import('./session-sidebar.tsx');
const { defaultSessionLaneStore } = await import('./session-lane-store.ts');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('keyboard focus on a session tab starts the same open intent as a press', async (t) => {
  defaultSessionLaneStore.clear();
  const reads = [];
  window.mixdogDesktop = {
    prefetchSession: async (id) => {
      reads.push(id);
      return true;
    },
  };
  t.after(() => {
    delete window.mixdogDesktop;
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => act(async () => root.unmount()));
  const tab = { key: 'session:kf1', title: 'Focus me', selection: { kind: 'session', id: 'kf1' } };
  await act(async () =>
    root.render(
      React.createElement(WorkspaceTabStrip, {
        tabs: [tab],
        activeKey: '',
        onSelectTab() {},
        onCloseTab() {},
        onReorderTab() {},
        onRenameSession() {},
        onNewTask() {},
      })
    )
  );
  const main = host.querySelector('.workspace-tab-main');
  await act(async () => main.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })));
  assert.deepEqual(reads, ['kf1'], 'focus requested the lane read');
});

test('every press asks the shared read again: no per-row success suppresses a later prefetch', async (t) => {
  const calls = [];
  let handle;
  function Probe() {
    handle = useSessionPrefetch(
      async (id) => {
        calls.push(id);
        return true;
      },
      false,
      false,
      []
    );
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => act(async () => root.unmount()));
  await act(async () => root.render(React.createElement(Probe)));
  handle('s1');
  await Promise.resolve();
  handle('s1');
  assert.deepEqual(calls, ['s1', 's1'], 'an acknowledged row is asked for again by the next intent');
});

async function tabScenario(t, id, onSelectTab = () => {}) {
  defaultSessionLaneStore.clear();
  const open = [];
  const subscribe = defaultSessionLaneStore.subscribe;
  defaultSessionLaneStore.subscribe = (sessionId, listener) => {
    open.push(sessionId);
    const stop = subscribe.call(defaultSessionLaneStore, sessionId, listener);
    return () => {
      open.splice(open.indexOf(sessionId), 1);
      stop();
    };
  };
  window.mixdogDesktop = { prefetchSession: async () => true };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    defaultSessionLaneStore.subscribe = subscribe;
    delete window.mixdogDesktop;
  });
  const tab = { key: `session:${id}`, title: 'Tab', selection: { kind: 'session', id } };
  await act(async () =>
    root.render(
      React.createElement(WorkspaceTabStrip, {
        tabs: [tab],
        activeKey: '',
        onSelectTab,
        onCloseTab() {},
        onReorderTab() {},
        onRenameSession() {},
        onNewTask() {},
      })
    )
  );
  const q = (selector) => host.querySelector(selector);
  const fire = (node, event) => act(async () => node.dispatchEvent(event));
  const press = () => fire(q('.workspace-tab'), new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await press();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  return { open, q, fire, press };
}

test('a tab click is an open that keeps the wait; the close control and the context menu end it', async (t) => {
  const opened = await tabScenario(t, 'tk1');
  assert.deepEqual(opened.open, ['tk1']);
  await opened.fire(opened.q('.workspace-tab-main'), new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(opened.open, ['tk1'], 'the tab navigated, so its wait stays until delivery');
  defaultSessionLaneStore.apply({ sessionId: 'tk1', snapshot: { sessionId: 'tk1', items: [] } });
  assert.deepEqual(opened.open, []);

  const closed = await tabScenario(t, 'tk2');
  assert.deepEqual(closed.open, ['tk2']);
  await closed.fire(closed.q('.workspace-tab-close'), new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(closed.open, [], 'closing the tab is no open');

  const menu = await tabScenario(t, 'tk3');
  assert.deepEqual(menu.open, ['tk3']);
  await menu.fire(menu.q('.workspace-tab'), new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.deepEqual(menu.open, [], 'the context menu is no open');
});
