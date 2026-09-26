import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { TurnReviewBar } from './TurnReview';

function phone(t) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  const previous = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', maxTouchPoints: 5 },
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const pending = [];
  dom.window.mixdogDesktop = {
    invokeCapability() {
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { dom, root, pending };
}

// A contended worktree reviews the session's own tool edits; a collapsed phone
// bar gets their counts as files and must still show them.
test('tracker counts sent as files fill a collapsed bar without the patch', async (t) => {
  const { dom, root, pending } = phone(t);
  const items = [
    { kind: 'user', id: 'prompt', text: 'Change a file' },
    { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated edit' },
  ];
  await act(async () =>
    root.render(React.createElement(TurnReviewBar, { items, sessionId: 'sess-tool', active: true, busy: false }))
  );
  while (pending.length) {
    await act(async () =>
      pending.shift()({
        value: {
          supported: true,
          authoritative: true,
          snapshotKind: 'tool',
          patch: '',
          patchOmitted: true,
          files: [{ path: 'src/a.js', status: 'M', additions: 7, deletions: 3 }],
          agents: [],
        },
      })
    );
  }
  const text = dom.window.document.querySelector('.turn-review-bar')?.textContent ?? '';
  assert.match(text, /\+7/);
  assert.match(text, /-3/);
});

// A phone's collapsed bar asks for files and counts only; opening it asks for
// the patch text it is about to draw.
test('a collapsed bar on a phone reads a summary, an opened one reads in full', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://mixdog.test/',
    pretendToBeVisual: true,
  });
  const previous = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', maxTouchPoints: 5 },
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  const pending = [];
  dom.window.mixdogDesktop = {
    invokeCapability(request) {
      requests.push(request);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const items = [
    { kind: 'user', id: 'prompt', text: 'Change a file' },
    { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated edit' },
  ];
  const answer = () =>
    act(async () =>
      pending.shift()({
        value: {
          supported: true,
          authoritative: true,
          snapshotKind: 'worktree',
          patch: '',
          patchOmitted: true,
          files: [{ path: 'a.txt', status: 'M', additions: 2, deletions: 1 }],
          agents: [],
        },
      })
    );
  await act(async () =>
    root.render(React.createElement(TurnReviewBar, { items, sessionId: 'sess-summary', active: true, busy: false }))
  );
  assert.ok(requests.length >= 1);
  assert.equal(requests[0].args[0].summary, true, 'collapsed: a summary read');
  while (pending.length) await answer();
  const toggle = dom.window.document.querySelector('.turn-review-bar button');
  assert.ok(toggle, 'the bar renders from the summary alone');
  const before = requests.length;
  await act(async () => toggle.click());
  assert.ok(requests.length > before, 'opening the bar re-reads');
  assert.equal(Object.hasOwn(requests.at(-1).args[0], 'summary'), false, 'opened: a full read');
});
