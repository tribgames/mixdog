import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  sessionSurfaceEngaged,
  sharedReadClearsUnread,
  shouldPublishSessionRead,
  useUnreadSessions,
} from './app-unread-sessions.ts';

const row = {
  id: 'session-a',
  preview: '',
  title: 'Task',
  updatedAt: 1,
  messageCount: 4,
  readMessageCount: 4,
  readRevision: 2,
  cwd: 'C:\\Project',
  classification: 'task',
  projectPath: null,
};

test('a read revision from the other surface clears completion-only unread', () => {
  assert.equal(sharedReadClearsUnread(row, 1), true);
  assert.equal(sharedReadClearsUnread(row, undefined), false);
  assert.equal(sharedReadClearsUnread({ ...row, messageCount: 5 }, 1), false);
});

test('visible activity publishes only when the shared cursor needs advancing', () => {
  assert.equal(shouldPublishSessionRead(row, 4, false), false);
  assert.equal(shouldPublishSessionRead(row, 5, false), true);
  assert.equal(shouldPublishSessionRead(row, 4, true), true);
});

function installDom({ visibility = 'visible', focused = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const state = { visibility, focused };
  Object.defineProperty(dom.window.document, 'visibilityState', {
    configurable: true,
    get: () => state.visibility,
  });
  Object.defineProperty(dom.window.document, 'hasFocus', {
    configurable: true,
    value: () => state.focused,
  });
  const previous = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    state,
    root: createRoot(dom.window.document.getElementById('root')),
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('engagement needs attention: a visible but unfocused surface is not reading', () => {
  const dom = installDom();
  try {
    assert.equal(sessionSurfaceEngaged(), true);
    dom.state.focused = false;
    assert.equal(sessionSurfaceEngaged(), false);
    dom.state.focused = true;
    dom.state.visibility = 'hidden';
    assert.equal(sessionSurfaceEngaged(), false);
  } finally {
    dom.close();
  }
});

test('a turn that completes behind another app stays unread until focus returns', async () => {
  const dom = installDom({ focused: false });
  const api = {};
  const working = { ...row, id: 'lead-a', messageCount: 1, readMessageCount: 0, working: true };
  const settled = { ...working, working: false };
  function Harness() {
    const viewedSessionRef = useRef('lead-a');
    Object.assign(api, useUnreadSessions({ viewedSessionRef }));
    return React.createElement('div', null, [...api.unreadSessionIds].join(','));
  }
  const marks = () => document.querySelector('#root div').textContent;
  try {
    await act(async () => dom.root.render(React.createElement(Harness)));
    // The turn runs, then settles, while the window sits behind another app.
    await act(async () => api.reconcileUnreadSessions([working]));
    await act(async () => api.reconcileUnreadSessions([settled]));
    assert.equal(marks(), 'lead-a');
    // Merely coming back on screen is still not reading it.
    await act(async () => api.consumeUnread('lead-a', [settled]));
    assert.equal(marks(), 'lead-a');

    dom.state.focused = true;
    await act(async () => api.consumeUnread('lead-a', [settled]));
    assert.equal(marks(), '');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});
