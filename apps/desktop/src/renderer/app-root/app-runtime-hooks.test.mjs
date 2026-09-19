import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

mock.module('../use-shell-update-reload.ts', {
  namedExports: { useShellUpdateReload() {} },
});
mock.module('./app-conversation-pane-renderer.tsx', {
  namedExports: {
    createPaneConversationRenderer: (options) => () => ({
      id: options.selectedSession?.id,
      errors: options.errors,
    }),
  },
});

const { useAppInvocation } = await import('./use-app-invocation.ts');
const { useAppSessionActivity } = await import('./use-app-session-activity.ts');
const { usePaneConversationRenderer } = await import('./use-pane-conversation-renderer.ts');

async function mountHook(t, useHook, initialOptions) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
  const saved = new Map();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  saved.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById('root'));
  let options = initialOptions;
  let result;
  function Harness() {
    result = useHook(options);
    return null;
  }
  const render = async (nextOptions) => {
    options = nextOptions;
    await act(async () => root.render(React.createElement(Harness)));
  };
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await render(options);
  return {
    get current() {
      return result;
    },
    window: dom.window,
    render,
  };
}

test('invocations clear stale errors, retain results, and report failures without rejecting the UI', async (t) => {
  const messages = [];
  const options = { error: '', connected: true, setError: (message) => messages.push(message) };
  const hook = await mountHook(t, useAppInvocation, options);
  assert.deepEqual(hook.current.errors, []);
  assert.equal(await hook.current.invokeResult(() => 42), 42);
  assert.deepEqual(messages, ['']);
  assert.equal(
    await hook.current.invokeResult(async () => {
      throw new Error('request failed');
    }),
    undefined
  );
  assert.deepEqual(messages, ['', '', 'request failed']);
  assert.equal(await hook.current.invoke(() => 'discarded result'), undefined);
  await hook.render({ ...options, error: 'request failed', connected: false });
  assert.deepEqual(hook.current.errors, ['request failed']);
  await hook.render({ ...options, connected: false });
  assert.deepEqual(hook.current.errors, ['Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop.']);
});

test('session activity preserves pinned titles, reconciles readiness, and wakes on phone resume', async (t) => {
  let finishRefresh;
  let refreshes = 0;
  const ready = [];
  let tabs = [
    { key: 'active', title: 'Old title', selection: { kind: 'session', id: 'active' } },
    { key: 'pinned', title: 'Pinned title', selection: { kind: 'session', id: 'active', title: 'Pinned title' } },
    { key: 'file', title: 'source.ts', selection: { kind: 'file', project: '/project', rel: 'source.ts' } },
  ];
  const options = {
    sessions: [
      { id: 'active', title: 'Updated title', working: true, sourceType: 'schedule', sourceName: 'backup' },
      { id: 'hook', title: 'Hook', working: true, sourceType: 'webhook', sourceName: 'notify' },
      { id: 'idle', title: 'Idle', working: false, sourceType: 'schedule', sourceName: 'idle' },
    ],
    setTabs: (update) => {
      tabs = update(tabs);
    },
    refreshSessions: () => {
      refreshes += 1;
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    },
    setSessionCatalogReady: (value) => ready.push(value),
  };
  const hook = await mountHook(t, useAppSessionActivity, options);
  assert.deepEqual(
    tabs.map((tab) => tab.title),
    ['Updated title', 'Pinned title', 'source.ts']
  );
  assert.deepEqual([...hook.current.runningAutomationNames.schedule], ['backup']);
  assert.deepEqual([...hook.current.runningAutomationNames.webhook], ['notify']);
  assert.equal(refreshes, 1);
  assert.deepEqual(ready, []);
  const previousTick = hook.current.windowFocusTick;
  await act(async () => hook.window.dispatchEvent(new hook.window.Event('pageshow')));
  assert.equal(hook.current.windowFocusTick, previousTick + 1);
  await act(async () => finishRefresh());
  assert.deepEqual(ready, [true]);
  const reconciledTabs = tabs;
  await hook.render({ ...options, sessions: [...options.sessions] });
  assert.equal(tabs, reconciledTabs);
  assert.equal(refreshes, 1);
});

test('conversation rendering stays cached until an input changes and never retains stale session data', async (t) => {
  const options = { selectedSession: { id: 'first' }, errors: ['first error'] };
  const hook = await mountHook(t, usePaneConversationRenderer, options);
  const initialRenderer = hook.current;
  await hook.render({ ...options });
  assert.equal(hook.current, initialRenderer);
  assert.deepEqual(hook.current(), { id: 'first', errors: ['first error'] });
  await hook.render({ ...options, selectedSession: { id: 'second' } });
  assert.notEqual(hook.current, initialRenderer);
  assert.deepEqual(hook.current(), { id: 'second', errors: ['first error'] });
});
