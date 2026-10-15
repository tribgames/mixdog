import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { TurnReviewBar } from './TurnReview';
import { installReviewDom } from './turn-review-test-support.mjs';

function phone(t) {
  const pending = [];
  const requests = [];
  const { dom, root } = installReviewDom(t, {
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', maxTouchPoints: 5 },
    desktop: {
      invokeCapability(request) {
        requests.push(request);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  });
  return { dom, root, pending, requests };
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

// A Git project's island counts the selected Changes source (uncommitted by
// default) from Git itself, never the runtime's session diff; Git evidence
// re-reads it, and at zero files it hides.
test('the island segment counts the Changes source and hides when it has no files', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let files = [{ path: 'b.ts', status: 'M', additions: 4, deletions: 1, untracked: false }];
  const reviews = [];
  const capabilities = [];
  const { dom, root } = installReviewDom(t, {
    desktop: {
      gitReview: async (cwd, source) => {
        reviews.push([cwd, source]);
        return { repository: true, root: 'C:/island-repo', base: 'HEAD', files };
      },
      invokeCapability: async ({ capability }) => {
        capabilities.push(capability);
        return { value: { supported: true, files: [], patch: '', agents: [] } };
      },
    },
  });
  const settle = (ms = 0) =>
    act(async () => {
      t.mock.timers.tick(ms);
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
  await act(async () =>
    root.render(
      React.createElement(TurnReviewBar, {
        variant: 'segment',
        items: [],
        cwd: 'C:/island-repo',
        sessionId: 'island-uncommitted',
        active: true,
        busy: false,
        onOpenChanges() {},
      })
    )
  );
  await settle();
  const segment = () => dom.window.document.querySelector('.turn-review-segment');
  assert.equal(segment()?.getAttribute('title'), 'Files 1');
  assert.equal(segment().getAttribute('aria-label'), 'Uncommitted');
  assert.equal(segment().querySelector('.diff-stats').textContent, '+4 −1');
  assert.deepEqual(reviews, [['C:/island-repo', 'uncommitted']]);
  assert.equal(capabilities.includes('getSessionReviewDiff'), false, 'a Git root never reads the session diff');
  // A commit lands; a Git action announces it and the watch re-reads.
  files = [];
  await act(async () => dom.window.dispatchEvent(new dom.window.Event('mixdog:git-changed')));
  await settle(3_500);
  assert.equal(reviews.length, 2);
  assert.equal(segment(), null, 'nothing uncommitted: the segment hides');
});

// A phone's collapsed bar asks for files and counts only; opening it asks for
// the patch text it is about to draw.
test('a collapsed bar on a phone reads a summary, an opened one reads in full', async (t) => {
  const { dom, root, pending, requests } = phone(t);
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
