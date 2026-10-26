import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';

const h = React.createElement;
const patchFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;

async function mountPane(t, desktop, props) {
  const view = installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'],
    rootId: 'root',
  });
  view.window.mixdogDesktop = desktop;
  // Landed file patches are announced in one batch per 100ms.
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await act(async () => view.root.render(h(SessionDiffPane, { active: true, onClose() {}, ...props })));
  await settle();
  return { ...view, settle, q: (selector) => view.document.querySelector(selector) };
}

test('a Git root picks its Changes source in the toolbar; each source lists, empties and diffs its own files', async (t) => {
  const reviews = [];
  const diffs = [];
  const view = await mountPane(
    t,
    {
      gitReview: async (cwd, source) => {
        reviews.push(source);
        const files =
          source === 'branch' ? [] : [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 1, untracked: false }];
        return { repository: true, root: 'C:/pane-repo', base: 'HEAD', files };
      },
      gitReviewDiff: async (cwd, path, untracked, source) => {
        diffs.push([cwd, path, untracked, source]);
        return patchFor(path);
      },
      invokeCapability: async () => ({ value: null }),
    },
    { sessionId: 'pane-git', cwd: 'C:/pane-repo' }
  );
  const toolbar = view.q('.session-diff-toolbar');
  const select = toolbar.querySelector('.session-diff-source-select');
  assert.ok(select, 'the source picker is in the toolbar row');
  assert.equal(select.nextElementSibling, toolbar.querySelector('.session-diff-scope'), 'before the scope pill');
  const trigger = select.querySelector('.mx-select-trigger');
  assert.equal(trigger.getAttribute('aria-label'), 'Changes source');
  assert.equal(trigger.dataset.tooltip, 'Compared with HEAD');
  assert.equal(select.querySelector('.mx-select-value').textContent, 'Uncommitted');
  // The open file read its own patch, lazily, from the same source.
  assert.deepEqual(diffs, [['C:/pane-repo', 'src/a.ts', false, 'uncommitted']]);
  assert.ok(view.q('.session-diff-section .inline-diff'));

  await act(async () =>
    trigger.dispatchEvent(new view.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  const options = [...view.document.querySelectorAll('.mx-menu [role="option"]')];
  assert.deepEqual(
    options.map((option) => option.textContent),
    ['Last turn', 'Current session', 'This branch', 'Uncommitted', 'Unstaged', 'Staged']
  );
  // The conversation's sources stand apart: one rule between them and Git's.
  const separators = [...view.document.querySelectorAll('.mx-menu [role="separator"]')];
  assert.equal(separators.length, 1);
  assert.equal(separators[0].previousElementSibling, options[1]);
  assert.equal(separators[0].nextElementSibling, options[2]);
  await act(async () => options[2].click());
  await view.settle();
  assert.equal(view.window.localStorage.getItem('mixdog.session-changes-source.v1'), 'branch');
  assert.deepEqual(reviews, ['uncommitted', 'branch']);
  assert.equal(view.q('.utility-dock-empty').textContent, 'No branch changes.');
});

test('a Git row opens against the repository root when the project is a subdirectory of it', async (t) => {
  const opened = [];
  const view = await mountPane(
    t,
    {
      gitReview: async () => ({
        repository: true,
        root: 'C:/mono',
        base: 'HEAD',
        files: [
          { path: 'packages/app/src/a.ts', status: 'M', additions: 1, deletions: 1, untracked: false },
          { path: 'docs/readme.md', status: 'M', additions: 1, deletions: 1, untracked: false },
        ],
      }),
      gitReviewDiff: async (cwd, path) => patchFor(path),
      invokeCapability: async () => ({ value: null }),
    },
    { sessionId: 'pane-subdir', cwd: 'C:\\mono\\packages\\app', onOpenFile: (path) => opened.push(path) }
  );
  const buttons = [...view.document.querySelectorAll('.session-diff-section .session-diff-open')];
  assert.equal(buttons.length, 2);
  await act(async () => buttons.forEach((button) => button.click()));
  // In the project: project-relative; elsewhere in the repository: absolute.
  assert.deepEqual(opened, ['src/a.ts', 'C:/mono/docs/readme.md']);
});

test('a capped set draws only the selected file (default: first); a header click selects another', async (t) => {
  const paths = Array.from({ length: 130 }, (_, index) => `src/f${String(index).padStart(3, '0')}.ts`);
  const batches = [];
  const view = await mountPane(
    t,
    {
      gitReview: async () => ({
        repository: true,
        root: 'C:/capped-pane',
        base: 'HEAD',
        files: paths.map((path) => ({ path, status: 'M', additions: 1, deletions: 1, untracked: false })),
      }),
      gitReviewDiffs: async (cwd, files) => {
        batches.push(files.map((file) => file.path));
        return { patches: files.map((file) => ({ path: file.path, patch: patchFor(file.path) })), omitted: [] };
      },
      invokeCapability: async () => ({ value: null }),
    },
    { sessionId: 'pane-capped', cwd: 'C:/capped-pane' }
  );
  const section = (path) => view.q(`.session-diff-section[data-session-diff-path="${path}"]`);
  assert.equal(view.document.querySelectorAll('.session-diff-section').length, 130, 'every file lists its header');
  assert.deepEqual(batches, [['src/f000.ts']], 'only the first file is read');
  assert.equal(view.document.querySelectorAll('.session-diff-section .inline-diff').length, 1);
  assert.ok(section('src/f000.ts').querySelector('.inline-diff'));
  assert.equal(section('src/f050.ts').dataset.collapsed, 'true', 'the others show their header only');
  await act(async () => section('src/f050.ts').querySelector('.session-diff-collapse').click());
  await view.settle();
  assert.deepEqual(batches.slice(1), [['src/f050.ts']]);
  assert.ok(section('src/f050.ts').querySelector('.inline-diff'));
  assert.equal(section('src/f000.ts').querySelector('.inline-diff'), null);
  assert.equal(view.document.querySelectorAll('.session-diff-section .inline-diff').length, 1);
});

test('an uncapped set reads all patches in one batch; deleted files start folded; a too-large file offers Open in editor', async (t) => {
  const batches = [];
  const opened = [];
  const view = await mountPane(
    t,
    {
      gitReview: async () => ({
        repository: true,
        root: 'C:/eager-pane',
        base: 'HEAD',
        files: [
          { path: 'a.ts', status: 'M', additions: 1, deletions: 1, untracked: false },
          { path: 'gone.ts', status: 'D', additions: 0, deletions: 3, untracked: false },
          { path: 'long.txt', status: 'M', additions: 1, deletions: 0, untracked: false },
        ],
      }),
      gitReviewDiffs: async (cwd, files) => {
        batches.push(files.map((file) => file.path));
        // One changed line past 1 MiB.
        const long = `diff --git a/long.txt b/long.txt\n--- a/long.txt\n+++ b/long.txt\n@@ -0,0 +1 @@\n+${'y'.repeat(1024 * 1024 + 1)}\n`;
        const patches = files.map((file) => ({
          path: file.path,
          patch: file.path === 'long.txt' ? long : patchFor(file.path),
        }));
        return { patches, omitted: [] };
      },
      invokeCapability: async () => ({ value: null }),
    },
    { sessionId: 'pane-eager', cwd: 'C:/eager-pane', onOpenFile: (path) => opened.push(path) }
  );
  const section = (path) => view.q(`.session-diff-section[data-session-diff-path="${path}"]`);
  assert.deepEqual(batches, [['a.ts', 'gone.ts', 'long.txt']], 'one batch, every file');
  assert.ok(section('a.ts').querySelector('.inline-diff'));
  assert.equal(section('gone.ts').dataset.collapsed, 'true', 'a deleted file starts folded');
  assert.equal(section('long.txt').querySelector('.inline-diff'), null);
  assert.match(section('long.txt').textContent, /This file is too large to display here\./);
  await act(async () => section('long.txt').querySelector('.session-diff-open-in-editor').click());
  assert.deepEqual(opened, ['long.txt']);
});

test('a folder that is not a Git repository shows no source picker and the session text', async (t) => {
  const view = await mountPane(
    t,
    {
      gitReview: async () => ({ repository: false, root: '', base: '', files: [] }),
      invokeCapability: async (request) => ({
        value:
          request.capability === 'getSessionReviewDiff'
            ? { supported: true, authoritative: true, complete: true, files: [], patch: '' }
            : null,
      }),
    },
    { sessionId: 'pane-plain', cwd: 'C:/pane-plain' }
  );
  assert.equal(view.q('.session-diff-source-select'), null);
  assert.equal(view.q('.utility-dock-empty').textContent, 'No changes from this session.');
});
