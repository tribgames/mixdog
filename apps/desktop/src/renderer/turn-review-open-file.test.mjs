import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';

test("turn review opens the owning project's file without toggling its diff; deleted files cannot open", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
  const previous = new Map(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.mixdogDesktop = {};
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  rememberAgentReviews(
    'draft:none',
    [],
    '',
    [
      { path: 'C:/Project/owner/src/current.ts', status: 'M', additions: 1, deletions: 0 },
      { path: 'src/deleted.ts', status: 'D', additions: 0, deletions: 1 },
    ],
    'worktree',
    ''
  );
  const opened = [];
  const render = async (cwd = 'C:\\Project\\owner') =>
    act(async () => {
      root.render(
        React.createElement(TurnReviewBar, {
          items: [],
          active: false,
          cwd,
          onOpenFile: (...args) => opened.push(args),
        })
      );
    });
  await render();
  const document = dom.window.document;
  await act(async () => document.querySelector('.turn-review-summary').click());
  const disclosure = document.querySelector('.turn-review-file');
  await act(async () => disclosure.click());
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  const buttons = [...document.querySelectorAll('.turn-review-open')];
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  await act(async () => {
    buttons[0].click();
    buttons[1].click();
  });
  assert.deepEqual(opened, [['C:\\Project\\owner', 'src/current.ts']]);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.turn-review-summary').getAttribute('aria-expanded'), 'true');
  await render('');
  assert.equal(buttons[0].disabled, true);
});
