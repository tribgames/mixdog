import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import { requestSessionDiffFile } from './session-diff-focus.ts';

const h = React.createElement;
const patchFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;

test('a file being read is a busy placeholder, not a tab; when the read finishes its row tab is selected', async (t) => {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const gates = [];
  dom.window.mixdogDesktop = {
    invokeCapability: (request) => {
      if (request.capability !== 'getSessionReviewDiff') return Promise.resolve({ value: null });
      const gate = Promise.withResolvers();
      gates.push(gate);
      return gate.promise;
    },
  };
  const wait = (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await act(async () => requestSessionDiffFile('sd-pending-cell', 'src/note.txt'));
  await act(async () => root.render(h(SessionDiffPane, { sessionId: 'sd-pending-cell', active: true, onClose() {} })));
  await wait();

  const list = document.querySelector('.session-diff-tabs');
  const pending = list.querySelector('[data-session-diff-tab="src/note.txt"][data-pending="true"]');
  assert.ok(pending, 'the file being read shows its cell');
  assert.equal(pending.textContent, 'note.txt');
  assert.equal(list.getAttribute('aria-busy'), 'true', 'the list reports the read');
  assert.equal(pending.getAttribute('aria-hidden'), 'true');
  assert.equal(
    pending.querySelector('button, [tabindex], [role="tab"], [aria-selected], [onclick]'),
    null,
    'nothing in the cell can be focused, selected or activated'
  );
  assert.equal(list.querySelector('[role="tab"]'), null, 'the list offers no tab for the pending file');

  const files = ['src/a.txt', 'src/note.txt'];
  await act(async () => {
    for (const gate of gates)
      gate.resolve({
        value: {
          supported: true,
          files: files.map((path) => ({ path, status: 'M', additions: 1, deletions: 1, binary: false })),
          patch: files.map(patchFor).join(''),
        },
      });
  });
  await wait(400);
  assert.equal(list.querySelector('[data-pending]'), null);
  assert.equal(list.getAttribute('aria-busy'), null);
  const tab = list.querySelector('[data-session-diff-tab="src/note.txt"] [role="tab"]');
  assert.ok(tab, 'the row has its tab');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.ok(tab.closest('.browser-tab').classList.contains('is-active'));
});
