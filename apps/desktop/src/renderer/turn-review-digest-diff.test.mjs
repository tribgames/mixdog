import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Element', 'HTMLElement', 'Node', 'MutationObserver', 'MouseEvent', 'Event', 'navigator'],
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.HTMLCanvasElement.prototype.getContext = () => ({
  font: '',
  measureText: (text) => ({ width: String(text).length * 8 }),
});
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { remoteToolOutput, remoteTranscriptSnapshot } = await import('../main/remote-transcript.ts');
const { summarizeSessionTranscriptReview } = await import('./turn-review-model.ts');
const { TurnReviewDigestDiff, orderedParts, resetTurnReviewDigestDiffs } = await import(
  './turn-review-digest-diff.tsx'
);

function diff(path, count, tag = 'z') {
  const body = Array.from({ length: count }, (_, index) => `+line ${index} ${tag.repeat(40)}`);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${count + 1} @@\n keep\n${body.join('\n')}\n`;
}
const row = (id, path, uiDiff) => ({
  id,
  kind: 'tool',
  name: 'edit',
  args: { file_path: path },
  result: 'ok',
  uiDiff,
  count: 1,
});

// Two calls carry the same two-file batch patch; a third touches one file again.
const batch = diff('src/a.ts', 200) + diff('src/b.ts', 200);
const items = [
  row('c1', 'src/a.ts', batch),
  row('c2', 'src/b.ts', batch),
  row('c3', 'src/a.ts', diff('src/a.ts', 200)),
];
const phone = remoteTranscriptSnapshot({ items }).items;
const desktopReview = summarizeSessionTranscriptReview(items);
const phoneReview = summarizeSessionTranscriptReview(phone);

// Each drawn diff is one child of the host (a spinner until the diff view loads).
async function mount(props) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next) => act(async () => root.render(React.createElement(TurnReviewDigestDiff, next)));
  await render(props);
  return { host, render, unmount: () => act(async () => root.unmount()) };
}
const settle = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
const hostOf = (list) => async (_sessionId, rowId) => remoteToolOutput({ items: list }, rowId);

test('the phone review has the digest files but not their diff text', () => {
  assert.ok(items.every((item) => phone.find((entry) => entry.id === item.id).uiDiffSummary));
  const entry = phoneReview.files.get('src/a.ts');
  assert.equal(entry.parts.length, 0);
  assert.deepEqual(
    entry.slots.map((slot) => slot.id),
    ['c1', 'c2', 'c3']
  );
  assert.equal(entry.additions, desktopReview.files.get('src/a.ts').additions);
});

test('opening a digest-derived review file loads its diff through readTranscriptItem, as the desktop draws it', async () => {
  resetTurnReviewDigestDiffs();
  const reads = [];
  const answer = hostOf(items);
  window.mixdogDesktop = {
    readTranscriptItem: async (sessionId, rowId) => {
      reads.push([sessionId, rowId]);
      return answer(sessionId, rowId);
    },
  };
  for (const name of ['src/a.ts', 'src/b.ts']) {
    const view = await mount({ sessionId: 's1', entry: phoneReview.files.get(name), name, cwd: '', mode: 'unified' });
    await settle();
    assert.doesNotMatch(view.host.textContent, /Diff detail unavailable/u, name);
    assert.equal(view.host.children.length, desktopReview.files.get(name).parts.length, name);
    await view.unmount();
  }
  assert.equal(reads.filter(([, rowId]) => rowId === 'c1').length, 1, 'a row read for one file is reused for the next');
});

test('file names match exactly: opening src/A.ts never draws src/a.ts', async () => {
  resetTurnReviewDigestDiffs();
  const mixed = [row('u1', 'src/A.ts', diff('src/A.ts', 200, 'u') + diff('src/a.ts', 200, 'l'))];
  const mixedPhone = remoteTranscriptSnapshot({ items: mixed }).items;
  const review = summarizeSessionTranscriptReview(mixedPhone);
  const desktop = summarizeSessionTranscriptReview(mixed);
  assert.deepEqual([...review.files.keys()], ['src/A.ts', 'src/a.ts']);
  window.mixdogDesktop = { readTranscriptItem: hostOf(mixed) };
  for (const name of ['src/A.ts', 'src/a.ts']) {
    const view = await mount({ sessionId: 's1', entry: review.files.get(name), name, cwd: '', mode: 'unified' });
    await settle();
    assert.equal(view.host.children.length, desktop.files.get(name).parts.length, name);
    await view.unmount();
  }
  // Under a session folder, the folder compares case-insensitively and the name does not.
  const rooted = [row('r1', '/Repo/src/A.ts', diff('/Repo/src/A.ts', 200) + diff('/repo/SRC/a.ts', 200))];
  const rootedPhone = remoteTranscriptSnapshot({ items: rooted }).items;
  const rootedReview = summarizeSessionTranscriptReview(rootedPhone, '/repo');
  const rootedDesktop = summarizeSessionTranscriptReview(rooted, '/repo');
  window.mixdogDesktop = { readTranscriptItem: hostOf(rooted) };
  assert.deepEqual([...rootedReview.files.keys()], [...rootedDesktop.files.keys()]);
  for (const name of rootedReview.files.keys()) {
    const view = await mount({
      sessionId: 's1',
      entry: rootedReview.files.get(name),
      name,
      cwd: '/repo',
      mode: 'unified',
    });
    await settle();
    assert.equal(view.host.children.length, rootedDesktop.files.get(name).parts.length, name);
    await view.unmount();
  }
});

test('held and loaded parts keep the order the diffs happened in', () => {
  const held = (tag) => ({ patch: `held-${tag}` });
  // text, digest row, text, digest row — as the transcript had them.
  const text = [
    { id: 't1', kind: 'tool', name: 'edit', args: {}, result: 'ok', uiDiff: diff('src/a.ts', 3) },
    row('d1', 'src/a.ts', diff('src/a.ts', 200)),
    { id: 't2', kind: 'tool', name: 'edit', args: {}, result: 'ok', uiDiff: diff('src/a.ts', 4) },
    row('d2', 'src/a.ts', diff('src/a.ts', 210)),
  ];
  const entry = summarizeSessionTranscriptReview(remoteTranscriptSnapshot({ items: text }).items).files.get('src/a.ts');
  assert.equal(entry.parts.length, 2);
  assert.deepEqual(
    entry.slots.map((slot) => (typeof slot === 'number' ? slot : slot.id)),
    [0, 'd1', 1, 'd2']
  );
  const drawn = orderedParts(
    { ...entry, parts: [held('t1'), held('t2')] },
    new Map(
      entry.slots
        .filter((slot) => typeof slot === 'object')
        .map((slot) => [`${slot.id}|${slot.revision}`, [{ patch: `loaded-${slot.id}` }]])
    )
  );
  assert.deepEqual(
    drawn.map((part) => part.patch),
    ['held-t1', 'loaded-d1', 'held-t2', 'loaded-d2']
  );
  // The desktop's own order, for the same transcript.
  const desktop = summarizeSessionTranscriptReview(text).files.get('src/a.ts');
  assert.equal(desktop.parts.length, 4);
});

test('a row that changed is read again, and a late answer for the old revision is dropped', async () => {
  resetTurnReviewDigestDiffs();
  const v1 = [row('s1r', 'src/a.ts', diff('src/a.ts', 200, 'o'))];
  const v2 = [row('s1r', 'src/a.ts', diff('src/a.ts', 200, 'n') + diff('src/a.ts', 200, 'n'))];
  const entryOf = (list) =>
    summarizeSessionTranscriptReview(remoteTranscriptSnapshot({ items: list }).items).files.get('src/a.ts');
  const [old, next] = [entryOf(v1), entryOf(v2)];
  assert.notEqual(old.slots[0].revision, next.slots[0].revision);
  let release;
  const reads = [];
  window.mixdogDesktop = {
    readTranscriptItem: (_sessionId, rowId) => {
      reads.push(reads.length);
      if (reads.length === 1) {
        return new Promise((resolve) => {
          release = () => resolve(remoteToolOutput({ items: v1 }, rowId));
        });
      }
      return Promise.resolve(remoteToolOutput({ items: v2 }, rowId));
    },
  };
  const view = await mount({ sessionId: 's1', entry: old, name: 'src/a.ts', cwd: '', mode: 'unified' });
  assert.match(view.host.textContent, /Loading/u);
  await view.render({ sessionId: 's1', entry: next, name: 'src/a.ts', cwd: '', mode: 'unified' });
  await settle();
  assert.equal(reads.length, 2, 'the new revision asks the host again');
  assert.equal(view.host.children.length, 2, 'drawn from the new revision (two parts)');
  await act(async () => release());
  await settle();
  assert.equal(view.host.children.length, 2, "the old revision's late answer changes nothing");
  await view.unmount();
});

test('a failed read says so, offers Retry, and Retry shows the diff', async () => {
  resetTurnReviewDigestDiffs();
  let attempts = 0;
  window.mixdogDesktop = {
    readTranscriptItem: async (_sessionId, rowId) => {
      attempts += 1;
      if (attempts <= 1) throw new Error('relay dropped');
      return remoteToolOutput({ items }, rowId);
    },
  };
  const entry = phoneReview.files.get('src/b.ts');
  const view = await mount({ sessionId: 's1', entry, name: 'src/b.ts', cwd: '', mode: 'unified' });
  await settle();
  assert.match(view.host.textContent, /Diff detail unavailable/u);
  const retry = view.host.querySelector('button');
  assert.equal(retry.textContent, 'Retry');
  await act(async () => retry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await settle();
  assert.doesNotMatch(view.host.textContent, /Diff detail unavailable/u);
  assert.equal(view.host.children.length, desktopReview.files.get('src/b.ts').parts.length);
  await view.unmount();
});

test('a withheld row is not drawn and not retried into a loop', async () => {
  resetTurnReviewDigestDiffs();
  window.mixdogDesktop = { readTranscriptItem: async (_sessionId, rowId) => ({ id: rowId, withheld: true }) };
  const view = await mount({
    sessionId: 's1',
    entry: phoneReview.files.get('src/b.ts'),
    name: 'src/b.ts',
    cwd: '',
    mode: 'unified',
  });
  await settle();
  assert.match(view.host.textContent, /Diff detail unavailable/u);
  await view.unmount();
});
