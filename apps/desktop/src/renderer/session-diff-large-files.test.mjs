import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';

const h = React.createElement;
const patchFor = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;
// Landed file patches are announced in one batch per 100ms.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));

/** A session whose reply listed `big.txt` (and the 12,000-line `huge.txt`)
 *  without their patches; the file-patch capability answers them. */
async function mount(t, sessionId, reply) {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const reads = [];
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability === 'getSessionReviewDiff') return { value: reply };
      if (request.capability === 'getSessionReviewFilePatch') {
        reads.push(request.args);
        const [file] = request.args;
        if (file === 'gone-wild.txt')
          return { value: { supported: true, path: file, patch: '', patchOmitted: true, reason: 'too_large' } };
        return { value: { supported: true, path: file, patch: patchFor(file, `-a\n+lazy ${file}\n`) } };
      }
      return { value: null };
    },
  };
  await act(async () => root.render(h(SessionDiffPane, { sessionId, active: true, onClose() {} })));
  await settle();
  await settle();
  const section = (path) =>
    [...document.querySelectorAll('.session-diff-section')].find((s) => s.dataset.sessionDiffPath === path);
  return { document, section, reads };
}

const omitted = (path, additions) => ({
  path,
  status: 'M',
  additions,
  deletions: 1,
  patchOmitted: true,
  reason: 'too_large',
});

test('a file listed without its patch reads it on its own when drawn, counts shown meanwhile', async (t) => {
  const view = await mount(t, 'sd-lazy', {
    supported: true,
    authoritative: true,
    complete: true,
    files: [
      { path: 'small.txt', status: 'M', additions: 1, deletions: 1 },
      omitted('big.txt', 40),
      omitted('gone-wild.txt', 30),
    ],
    patch: patchFor('small.txt', '-a\n+b\n'),
  });
  assert.match(view.section('small.txt').textContent, /\+b|b/);
  assert.match(view.section('big.txt').querySelector('.diff-stats').textContent, /\+40/);
  assert.match(view.section('big.txt').textContent, /lazy big\.txt/);
  // Past even the one-file read's cap: a note, never a diff.
  assert.match(view.section('gone-wild.txt').textContent, /This file is too large to display here\./);
  assert.deepEqual(view.reads.map(([file]) => file).sort(), ['big.txt', 'gone-wild.txt']);
  // Cached per file and result revision: a re-render reads nothing again.
  await settle();
  assert.equal(view.reads.length, 2);
});

test('a file past 15,000 changed lines is never read or drawn; a whole-diff failure adds no banner', async (t) => {
  const view = await mount(t, 'sd-huge', {
    supported: true,
    authoritative: true,
    complete: true,
    files: [omitted('huge.txt', 15_000)],
    patch: '',
    diffTooLarge: true,
  });
  assert.equal(view.document.querySelector('.session-diff-notice'), null);
  const huge = view.section('huge.txt');
  assert.match(huge.querySelector('.diff-stats').textContent, /\+15000/);
  assert.equal(huge.dataset.collapsed, undefined, 'files start expanded');
  assert.match(huge.textContent, /This file is too large to display here\./);
  assert.equal(view.reads.length, 0, 'its patch is never read');
});
