import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import { requestSessionDiffFile, requestSessionDiffList } from './session-diff-focus.ts';
import { bumpTurnChangesEpoch } from './turn-changes-model.ts';

const h = React.createElement;
const patchFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;

const sectionPaths = (view) =>
  [...view.document.querySelectorAll('.session-diff-section')].map((section) => section.dataset.sessionDiffPath);

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

test('a file request opens that one file in its own tab beside Changes; Changes shows every file', async (t) => {
  const view = await mountPane(t, 'sd-focus', ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(sectionPaths(view), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(view.q('[data-session-diff-tab]'), null);
  const readsBefore = view.reads.length;
  await act(async () => requestSessionDiffFile('sd-focus', 'src/b.ts'));
  await view.settle();
  // No change signal moved: the open adopts the settled result, no re-read.
  assert.equal(view.reads.length, readsBefore);
  const tab = view.q('[data-session-diff-tab="src/b.ts"]');
  assert.ok(tab.classList.contains('is-active'));
  assert.equal(tab.textContent, 'b.ts');
  assert.deepEqual(sectionPaths(view), ['src/b.ts']);
  assert.ok(view.q('.session-diff-section .inline-diff'));
  assert.equal(view.q('.session-diff-notice'), null);
  // A second file adds a second tab; the first stays.
  await act(async () => requestSessionDiffFile('sd-focus', 'src/c.ts'));
  await view.settle();
  assert.deepEqual(
    [...view.document.querySelectorAll('[data-session-diff-tab]')].map((entry) => entry.dataset.sessionDiffTab),
    ['src/b.ts', 'src/c.ts']
  );
  assert.deepEqual(sectionPaths(view), ['src/c.ts']);
  // The Changes tab shows every file again; closing a file tab drops it.
  const changes = [...view.document.querySelectorAll('.browser-tab-select')].find(
    (entry) => entry.textContent === 'Changes'
  );
  await act(async () => changes.click());
  assert.deepEqual(sectionPaths(view), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  await act(async () => view.q('[data-session-diff-tab="src/b.ts"] .browser-tab-close').click());
  assert.equal(view.q('[data-session-diff-tab="src/b.ts"]'), null);
});
test('opening the pane by a file request joins the one initial read instead of queuing a second', async (t) => {
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
  await act(async () => requestSessionDiffFile('sd-join', 'src/b.ts'));
  await act(async () => root.render(h(SessionDiffPane, { sessionId: 'sd-join', active: true, onClose() {} })));
  const wait = (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await wait();
  assert.equal(gates.length, 1);
  await act(async () => {
    gates[0].resolve({
      value: {
        supported: true,
        files: ['src/a.ts', 'src/b.ts'].map((path) => ({
          path,
          status: 'M',
          additions: 1,
          deletions: 1,
          binary: false,
        })),
        patch: ['src/a.ts', 'src/b.ts'].map(patchFor).join(''),
      },
    });
  });
  await wait(400);
  assert.equal(gates.length, 1, 'no second whole-session read behind the initial one');
  assert.ok(document.querySelector('[data-session-diff-tab="src/b.ts"]'));
});

test('a pane opened by one file shows only that file tab; View changes adds the Changes tab', async (t) => {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) =>
      request.capability === 'getSessionReviewDiff'
        ? {
            value: {
              supported: true,
              files: ['src/a.ts', 'src/b.ts'].map((path) => ({
                path,
                status: 'M',
                additions: 1,
                deletions: 1,
                binary: false,
              })),
              patch: ['src/a.ts', 'src/b.ts'].map(patchFor).join(''),
            },
          }
        : { value: null },
  };
  // The turn card posts the file request, then the pane opens.
  await act(async () => requestSessionDiffFile('sd-file-open', 'src/b.ts'));
  await act(async () => root.render(h(SessionDiffPane, { sessionId: 'sd-file-open', active: true, onClose() {} })));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  await settle();
  const q = (selector) => document.querySelector(selector);
  assert.equal(q('[data-session-diff-changes-tab]'), null);
  assert.ok(q('[data-session-diff-tab="src/b.ts"]').classList.contains('is-active'));
  assert.deepEqual(
    [...document.querySelectorAll('.session-diff-section')].map((section) => section.dataset.sessionDiffPath),
    ['src/b.ts']
  );
  // View changes / the island asks for every file: the Changes tab appears.
  await act(async () => requestSessionDiffList('sd-file-open'));
  await settle();
  assert.ok(q('[data-session-diff-changes-tab]').classList.contains('is-active'));
  assert.ok(q('[data-session-diff-tab="src/b.ts"]'));
});
test('Changes closes like any tab; closing the last tab closes the side panel', async (t) => {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) =>
      request.capability === 'getSessionReviewDiff'
        ? {
            value: {
              supported: true,
              files: ['src/a.ts', 'src/b.ts'].map((path) => ({
                path,
                status: 'M',
                additions: 1,
                deletions: 1,
                binary: false,
              })),
              patch: ['src/a.ts', 'src/b.ts'].map(patchFor).join(''),
            },
          }
        : { value: null },
  };
  let closed = 0;
  await act(async () =>
    root.render(h(SessionDiffPane, { sessionId: 'sd-close', active: true, onClose: () => (closed += 1) }))
  );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await settle();
  const q = (selector) => document.querySelector(selector);
  await act(async () => requestSessionDiffFile('sd-close', 'src/b.ts'));
  await settle();
  // Closing Changes while a file tab is open keeps the panel on that file.
  await act(async () => q('[data-session-diff-changes-tab] .browser-tab-close').click());
  assert.equal(q('[data-session-diff-changes-tab]'), null);
  assert.ok(q('[data-session-diff-tab="src/b.ts"]').classList.contains('is-active'));
  assert.equal(closed, 0);
  // Closing the last tab closes the side panel.
  await act(async () => q('[data-session-diff-tab="src/b.ts"] .browser-tab-close').click());
  assert.equal(closed, 1);
});
test('a list request (island files segment) shows every file from the top', async (t) => {
  const view = await mountPane(t, 'sd-list', ['src/a.ts', 'src/b.ts']);
  await act(async () => requestSessionDiffFile('sd-list', 'src/b.ts'));
  await view.settle();
  assert.deepEqual(sectionPaths(view), ['src/b.ts']);
  const stack = view.q('.session-diff-stack');
  stack.scrollTop = 120;
  await act(async () => requestSessionDiffList('sd-list'));
  await view.settle();
  assert.deepEqual(sectionPaths(view), ['src/a.ts', 'src/b.ts']);
  assert.equal(view.q('.session-diff-stack').scrollTop, 0);
});
test('an open Changes pane re-reads when the history is deleted and empties', async (t) => {
  const paths = ['src/a.ts', 'src/b.ts'];
  const view = await mountPane(t, 'sd-cleared', paths);
  assert.deepEqual(sectionPaths(view), ['src/a.ts', 'src/b.ts']);
  const reads = view.reads.length;
  // Delete history landed in the runtime; the island bumps the session's epoch.
  paths.length = 0;
  await act(async () => bumpTurnChangesEpoch('sd-cleared'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.ok(view.reads.length > reads, 'the pane re-read the session diff');
  assert.deepEqual(sectionPaths(view), []);
});
test('a requested file that left the session diff shows every file without a notice', async (t) => {
  const view = await mountPane(t, 'sd-missing', ['src/a.ts', 'src/b.ts']);
  await act(async () => requestSessionDiffFile('sd-missing', 'src/gone.ts'));
  await view.settle();
  assert.deepEqual(sectionPaths(view), ['src/a.ts', 'src/b.ts']);
  assert.equal(view.q('.session-diff-notice'), null);
});
test('a file already on screen opens at once; a hidden document still waits for the adopted read to judge it', async (t) => {
  const view = await mountPane(t, 'sd-hidden', ['src/a.ts', 'src/b.ts']);
  const setVisibility = controlVisibility(view);
  await setVisibility('hidden');
  const readsBefore = view.reads.length;
  await act(async () => requestSessionDiffFile('sd-hidden', 'src/b.ts'));
  await view.settle();
  // The file is among the rows on screen, so its tab opens as fast as
  // "Changes"; the skipped refresh means nothing is judged (no notice) yet.
  assert.equal(view.reads.length, readsBefore);
  assert.equal(view.q('.session-diff-notice'), null);
  assert.deepEqual(sectionPaths(view), ['src/b.ts']);
  await setVisibility('visible');
  await view.settle();
  // Return re-adopts the cached result; no signal arrived, so no new read.
  assert.equal(view.reads.length, readsBefore);
  assert.deepEqual(sectionPaths(view), ['src/b.ts']);
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
  assert.deepEqual(sectionPaths(view), ['src/b.ts']);
});

test('a request for another session is ignored', async (t) => {
  const view = await mountPane(t, 'sd-own', ['src/a.ts', 'src/b.ts']);
  await act(async () => requestSessionDiffFile('sd-other', 'src/a.ts'));
  await view.settle();
  assert.equal(sectionPaths(view).length, 2);
  assert.equal(view.q('.session-diff-notice'), null);
  await act(async () => requestSessionDiffFile('sd-other', null));
});

test('the pane completes an old record with the transcript edit: same counts, diff and outside marker as the island', async (t) => {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const outside = 'C:/Users/me/AppData/Local/Temp/mixdog-dl-outside/outside-note.txt';
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) =>
      request.capability === 'getSessionReviewDiff'
        ? {
            value: {
              supported: true,
              authoritative: true,
              files: [
                { path: outside, status: 'A', additions: 0, deletions: 0, reason: 'file is outside the recorded root' },
                { path: 'note.txt', status: 'A', additions: 3, deletions: 0 },
              ],
              patch: patchFor('note.txt'),
            },
          }
        : { value: null },
  };
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  defaultSessionLaneStore.apply({
    sessionId: 'sd-merge',
    frameSource: 'live',
    snapshot: {
      sessionId: 'sd-merge',
      contentRevision: 1,
      items: [
        {
          id: 't1',
          kind: 'tool',
          name: 'write',
          args: { file_path: outside, content: 'Single line of text' },
          result: 'Created',
        },
      ],
    },
  });
  await act(async () =>
    root.render(h(SessionDiffPane, { sessionId: 'sd-merge', active: true, cwd: 'C:/Users/me/proj', onClose() {} }))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const section = [...document.querySelectorAll('.session-diff-section')].find(
    (entry) => entry.dataset.sessionDiffPath === outside
  );
  assert.match(section.querySelector('.session-diff-section-head .diff-stats').textContent, /\+1/);
  assert.equal(section.querySelector('.session-diff-row-dir'), null);
  assert.equal(section.querySelector('.session-diff-section-title').title, outside);
  assert.equal(document.querySelector('.inline-diff-empty'), null);
  // The pane total (note.txt +3, outside-note.txt +1) is what the island shows.
  assert.equal(document.querySelector('.session-diff-summary .diff-stats i').textContent, '+4');
});

test('a complete runtime set is final: transcript edits never resurrect an undone file, and fill only unmeasured rows', async (t) => {
  const { dom, document, root } = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent'],
    rootId: 'root',
  });
  const outside = 'C:/Users/me/Temp/outside/outside-note.txt';
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) =>
      request.capability === 'getSessionReviewDiff'
        ? {
            value: {
              supported: true,
              authoritative: true,
              complete: true,
              files: [{ path: outside, status: 'A', additions: 0, deletions: 0, unmeasured: true, reason: 'x' }],
              patch: '',
            },
          }
        : { value: null },
  };
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  const write = (id, path, content) => ({
    id,
    kind: 'tool',
    name: 'write',
    args: { file_path: path, content },
    result: 'Created',
  });
  defaultSessionLaneStore.apply({
    sessionId: 'sd-final',
    frameSource: 'live',
    snapshot: {
      sessionId: 'sd-final',
      contentRevision: 1,
      // undone.txt was written and then undone: the runtime no longer lists it.
      items: [write('w1', outside, 'Single line of text'), write('w2', 'undone.txt', 'a\nb')],
    },
  });
  await act(async () => root.render(h(SessionDiffPane, { sessionId: 'sd-final', active: true, onClose() {} })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const rows = [...document.querySelectorAll('.session-diff-section')];
  assert.equal(rows.length, 1);
  assert.match(rows[0].querySelector('.diff-stats').textContent, /\+1/);
  assert.equal(document.querySelector('.session-diff-toolbar .session-diff-scope').title, '1 file changed');
});
test('a request with its root opens the matching file when two roots both hold x.txt', async (t) => {
  const view = await mountPane(t, 'sd-roots', ['C:/r1/x.txt', 'C:/r2/x.txt']);
  await act(async () => requestSessionDiffFile('sd-roots', 'x.txt', 'C:\\r2'));
  await view.settle();
  assert.equal(view.q('.session-diff-notice'), null);
  assert.deepEqual(sectionPaths(view), ['C:/r2/x.txt']);
});

test('Windows root matching ignores case; the request finds C:/Work/x.ts from c:work', async (t) => {
  const view = await mountPane(t, 'sd-case', ['C:/Work/x.ts', 'C:/Other/x.ts']);
  await act(async () => requestSessionDiffFile('sd-case', 'x.ts', 'c:\\work'));
  await view.settle();
  assert.equal(view.q('.session-diff-notice'), null);
  assert.deepEqual(sectionPaths(view), ['C:/Work/x.ts']);
});
