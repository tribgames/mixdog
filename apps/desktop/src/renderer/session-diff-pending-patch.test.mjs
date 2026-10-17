import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';

const h = React.createElement;
const patchFor = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;
// Landed file patches are announced in one batch per 100ms.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));

test('the list is drawn once the unfolded files have their diffs, never as one-line notes that later grow', async (t) => {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reply = {
    supported: true,
    authoritative: true,
    complete: true,
    files: [
      { path: 'first.txt', status: 'M', additions: 40, deletions: 1, patchOmitted: true, reason: 'too_large' },
      { path: 'second.txt', status: 'M', additions: 40, deletions: 1, patchOmitted: true, reason: 'too_large' },
    ],
    patch: '',
  };
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability === 'getSessionReviewDiff') return { value: reply };
      if (request.capability === 'getSessionReviewFilePatch') {
        await gate;
        const [file] = request.args;
        return { value: { supported: true, path: file, patch: patchFor(file, `-a\n+lazy ${file}\n`) } };
      }
      return { value: null };
    },
  };
  await act(async () => root.render(h(SessionDiffPane, { sessionId: 'sd-hold', active: true, onClose() {} })));
  await settle();
  await settle();
  // Reads are in flight: no section is on screen to grow later.
  assert.equal(document.querySelectorAll('.session-diff-section').length, 0);
  assert.equal(document.body.textContent.includes('Loading diff…'), false);
  release();
  await settle();
  await settle();
  const sections = [...document.querySelectorAll('.session-diff-section')];
  assert.equal(sections.length, 2);
  for (const section of sections) {
    assert.match(section.textContent, /lazy /);
    assert.equal(section.textContent.includes('Loading diff…'), false);
  }
});
