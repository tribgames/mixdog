import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import { requestSessionDiffFile } from './session-diff-focus.ts';

const h = React.createElement;
const patchFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;

async function mountPane(t, sessionId, paths) {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const reads = [];
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability === 'getSessionReviewDiff') reads.push(request);
      if (request.capability !== 'getSessionReviewDiff') return { value: null };
      return {
        value: {
          supported: true,
          files: paths.map((path) => ({ path, status: 'M', additions: 1, deletions: 1, binary: false })),
          patch: paths.map(patchFor).join(''),
        },
      };
    },
  };
  await act(async () => root.render(h(SessionDiffPane, { sessionId, active: true, onClose() {} })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await settle();
  return { dom, document, reads, settle, q: (selector) => document.querySelector(selector) };
}

function controlVisibility(view) {
  let state = 'visible';
  Object.defineProperty(view.document, 'visibilityState', { configurable: true, get: () => state });
  return (next) =>
    act(async () => {
      state = next;
      view.document.dispatchEvent(new view.dom.window.Event('visibilitychange'));
    });
}

test('a file request re-reads the session diff and opens that file', async (t) => {
  const view = await mountPane(t, 'sd-focus', ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.ok(view.q('.session-diff-files'));
  const readsBefore = view.reads.length;
  await act(async () => requestSessionDiffFile('sd-focus', 'src/b.ts'));
  await view.settle();
  assert.ok(view.reads.length > readsBefore);
  assert.equal(view.q('.session-diff-files'), null);
  assert.equal(view.q('.session-diff-path').title, 'src/b.ts');
  assert.equal(view.q('.session-diff-notice'), null);
});

test('a requested file that left the session diff shows a notice, not another file', async (t) => {
  const view = await mountPane(t, 'sd-missing', ['src/a.ts', 'src/b.ts']);
  await act(async () => requestSessionDiffFile('sd-missing', 'src/gone.ts'));
  await view.settle();
  assert.ok(view.q('.session-diff-files'));
  assert.equal(view.q('.session-diff-body'), null);
  assert.equal(view.q('.session-diff-notice').textContent, 'src/gone.ts is no longer in the session diff.');
  // Choosing a file clears the notice.
  await act(async () => {
    view.q('.changes-file-main').dispatchEvent(new view.document.defaultView.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(view.q('.session-diff-notice'), null);
});

test('a file request made while the document is hidden waits for the next adopted read', async (t) => {
  const view = await mountPane(t, 'sd-hidden', ['src/a.ts', 'src/b.ts']);
  const setVisibility = controlVisibility(view);
  await setVisibility('hidden');
  const readsBefore = view.reads.length;
  await act(async () => requestSessionDiffFile('sd-hidden', 'src/b.ts'));
  await view.settle();
  // The refresh was skipped: stale rows must not be judged yet.
  assert.equal(view.reads.length, readsBefore);
  assert.equal(view.q('.session-diff-notice'), null);
  assert.ok(view.q('.session-diff-files'));
  await setVisibility('visible');
  await view.settle();
  assert.ok(view.reads.length > readsBefore);
  assert.equal(view.q('.session-diff-files'), null);
  assert.equal(view.q('.session-diff-path').title, 'src/b.ts');
  assert.equal(view.q('.session-diff-notice'), null);
});

test('a file request whose own refresh was superseded resolves on the adopted read', async (t) => {
  const view = await mountPane(t, 'sd-superseded', ['src/a.ts', 'src/b.ts']);
  const gate = Promise.withResolvers();
  const original = view.dom.window.mixdogDesktop.invokeCapability;
  view.dom.window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getSessionReviewDiff') {
      view.reads.push(request);
      await gate.promise;
    }
    return original({ ...request, capability: 'getSessionReviewDiff' });
  };
  await act(async () => requestSessionDiffFile('sd-superseded', 'src/b.ts'));
  // A newer request for the same file supersedes the first request's read.
  await act(async () => requestSessionDiffFile('sd-superseded', 'src/b.ts'));
  await view.settle();
  assert.equal(view.q('.session-diff-notice'), null);
  await act(async () => gate.resolve());
  await view.settle();
  assert.equal(view.q('.session-diff-notice'), null);
  assert.equal(view.q('.session-diff-files'), null);
  assert.equal(view.q('.session-diff-path').title, 'src/b.ts');
});

test('a request for another session is ignored', async (t) => {
  const view = await mountPane(t, 'sd-own', ['src/a.ts', 'src/b.ts']);
  await act(async () => requestSessionDiffFile('sd-other', 'src/a.ts'));
  await view.settle();
  assert.ok(view.q('.session-diff-files'));
  assert.equal(view.q('.session-diff-notice'), null);
  await act(async () => requestSessionDiffFile('sd-other', null));
});
