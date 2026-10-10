import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main class="app-shell"></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator'],
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.HTMLElement ??= window.HTMLElement;
for (const name of ['attachEvent', 'detachEvent']) window.HTMLElement.prototype[name] ??= function noop() {};
window.Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const { SessionSearchHost } = await import('./SessionSearchDialog.tsx');
const { openSessionSearch } = await import('./session-search.ts');

const sessions = ['a', 'b'].map((id, index) => ({
  id,
  title: `Session ${id}`,
  preview: '',
  updatedAt: 0,
  activityAt: 10 - index,
  messageCount: 1,
  cwd: '',
  classification: 'task',
  projectPath: null,
}));

async function setup() {
  const opened = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(React.createElement(SessionSearchHost, { sessions, onOpenSession: (id) => opened.push(id) }))
  );
  await act(async () => openSessionSearch());
  return { opened, root };
}

test('Enter on the selected result opens that session and closes the dialog', async () => {
  const { opened, root } = await setup();
  try {
    const input = document.querySelector('input');
    const key = (name) =>
      act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      });
    await key('ArrowDown');
    await key('Enter');
    assert.deepEqual(opened, ['b']);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test('clicking a result opens that session', async () => {
  const { opened, root } = await setup();
  try {
    await act(async () => document.querySelectorAll('[role="option"]')[1].click());
    assert.deepEqual(opened, ['b']);
  } finally {
    await act(async () => root.unmount());
  }
});
