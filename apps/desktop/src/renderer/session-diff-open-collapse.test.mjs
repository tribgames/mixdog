import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';

const h = React.createElement;
const OUTSIDE = 'C:/Temp/outside/outside-note.txt';
const patchFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;

async function mount(t, sessionId, extra = {}) {
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
              authoritative: true,
              complete: true,
              files: [
                { path: 'note.txt', status: 'M', additions: 1, deletions: 1 },
                { path: 'gone.txt', status: 'D', additions: 0, deletions: 1 },
                { path: OUTSIDE, status: 'A', additions: 1, deletions: 0 },
              ],
              patch: patchFor('note.txt') + patchFor('gone.txt') + patchFor(OUTSIDE),
            },
          }
        : { value: null },
  };
  await act(async () => root.render(h(SessionDiffPane, { sessionId, active: true, onClose() {}, ...extra })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const section = (path) =>
    [...document.querySelectorAll('.session-diff-section')].find((s) => s.dataset.sessionDiffPath === path);
  return { document, section };
}

test('the open button opens in-project and outside files; deleted files are disabled', async (t) => {
  const opened = [];
  const view = await mount(t, 'sd-open', { onOpenFile: (path) => opened.push(path) });
  assert.equal(view.document.querySelector('.side-file-status-row'), null, 'the Changes view draws no editor footer');
  const click = (el) => act(async () => el.click());
  await click(view.section('note.txt').querySelector('.session-diff-open'));
  await click(view.section(OUTSIDE).querySelector('.session-diff-open'));
  assert.deepEqual(opened, ['note.txt', OUTSIDE]);
  const gone = view.section('gone.txt');
  assert.equal(gone.querySelector('.session-diff-open').disabled, true);
  assert.equal(gone.querySelector('.session-diff-open').dataset.tooltip, 'Deleted files cannot be opened');
  await click(gone.querySelector('.session-diff-open'));
  assert.equal(opened.length, 2);
});

test('a click anywhere on a file row collapses that file, and opening does not toggle', async (t) => {
  const opened = [];
  const view = await mount(t, 'sd-collapse', { onOpenFile: (path) => opened.push(path) });
  const note = view.section('note.txt');
  assert.ok(note.querySelector('.inline-diff'));
  // The row toggle spans icon, name, chevron and counts.
  const toggle = note.querySelector('.session-diff-collapse');
  assert.ok(toggle.querySelector('.session-diff-row-name'));
  assert.ok(toggle.querySelector('.diff-stats'));
  await act(async () => toggle.querySelector('.diff-stats').click());
  assert.equal(view.section('note.txt').dataset.collapsed, 'true');
  assert.equal(view.section('note.txt').querySelector('.inline-diff'), null);
  assert.ok(view.section(OUTSIDE).querySelector('.inline-diff'));
  await act(async () => view.section('note.txt').querySelector('.session-diff-row-name').click());
  assert.ok(view.section('note.txt').querySelector('.inline-diff'));
  // The open button opens the file without folding the row.
  await act(async () => view.section('note.txt').querySelector('.session-diff-open').click());
  assert.deepEqual(opened, ['note.txt']);
  assert.ok(view.section('note.txt').querySelector('.inline-diff'));
});

test('file tabs render next to Changes and select/close', async (t) => {
  const calls = [];
  const view = await mount(t, 'sd-tabs', {
    fileTabs: {
      tabs: [{ key: 'k1', name: 'note.txt', title: 'note.txt' }],
      onSelect: (key) => calls.push(['select', key]),
      onClose: (key) => calls.push(['close', key]),
    },
  });
  const tab = view.document.querySelector('[data-session-diff-file-tab="k1"]');
  await act(async () => tab.querySelector('.browser-tab-select').click());
  await act(async () => tab.querySelector('.browser-tab-close').click());
  assert.deepEqual(calls, [
    ['select', 'k1'],
    ['close', 'k1'],
  ]);
});

test('closing the last diff tab with an editor tab left selects that editor tab, not Changes', async (t) => {
  const calls = [];
  const view = await mount(t, 'sd-last-diff', {
    fileTabs: {
      tabs: [{ key: 'k1', name: 'note.txt', title: 'note.txt' }],
      onSelect: (key) => calls.push(['select', key]),
      onClose: (key) => calls.push(['close', key]),
    },
  });
  const { requestSessionDiffFile } = await import('./session-diff-focus.ts');
  await act(async () => requestSessionDiffFile('sd-last-diff', 'note.txt'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.ok(view.document.querySelector('[data-session-diff-tab="note.txt"]'), 'the file opened in its own Diff tab');
  assert.equal(view.document.querySelector('.side-file-status-row'), null, 'an individual Diff tab draws no editor footer');
  // Close Changes (a diff tab is open), then the last diff tab.
  await act(async () => view.document.querySelector('[data-session-diff-changes-tab] .browser-tab-close').click());
  calls.length = 0;
  await act(async () => view.document.querySelector('[data-session-diff-tab="note.txt"] .browser-tab-close').click());
  assert.deepEqual(calls, [['select', 'k1']]);
  assert.equal(view.document.querySelector('[data-session-diff-changes-tab]'), null);
});
