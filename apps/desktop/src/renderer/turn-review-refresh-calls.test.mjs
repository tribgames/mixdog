import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { TurnReviewBar } from './TurnReview';
import { installReviewDom } from './turn-review-test-support.mjs';
import { _runIdleReclaimForTest } from './idle-reclaim';

function mount(t, sessionId = 'sess-review-calls') {
  const pending = [];
  const requests = [];
  const { dom, root } = installReviewDom(t, {
    desktop: {
      invokeCapability(request) {
        requests.push(request);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  });
  const render = (items, busy, active = true) =>
    act(async () => root.render(React.createElement(TurnReviewBar, { items, sessionId, active, busy })));
  const answer = (value = {}) =>
    act(async () =>
      pending.shift()({
        value: {
          supported: true,
          authoritative: true,
          snapshotKind: 'worktree',
          patch: '',
          files: [],
          agents: [],
          ...value,
        },
      })
    );
  const bar = () => dom.window.document.querySelector('.turn-review-bar');
  const entryPending = () => Boolean(dom.window.document.querySelector('[data-entry-pending]'));
  return { dom, render, answer, bar, entryPending, pending, requests };
}

const prompt = { kind: 'user', id: 'prompt', text: 'Change a file' };
const edit = (id) => ({ kind: 'tool', id, name: 'apply_patch', args: {}, result: `Updated ${id}` });

test('a busy turn boundary reads the turn review once, not once per effect', async (t) => {
  const { render, answer, pending, requests } = mount(t);
  await render([prompt, edit('first')], true);
  assert.equal(requests.length, 1);
  await answer();
  // The boundary effect and the busy poll asked in the same commit; the read
  // already sent answered both, so no follow-up repeats it.
  assert.equal(pending.length, 0);
  assert.equal(requests.length, 1);

  await render([prompt, edit('first'), edit('second')], true);
  assert.equal(requests.length, 2);
  await answer();
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.capability === 'getTurnReviewDiff'));
});

test('a boundary that moves while its read is in flight still gets its own read', async (t) => {
  const { render, answer, pending, requests } = mount(t);
  await render([prompt, edit('first')], true);
  assert.equal(requests.length, 1);
  await render([prompt, edit('first'), edit('second')], true);
  assert.equal(requests.length, 1, 'the newer boundary waits behind the read in flight');
  await answer();
  assert.equal(requests.length, 2, 'the newer boundary is read after the older answer');
  await answer();
  assert.equal(pending.length, 0);
  assert.equal(requests.length, 2);
});

test("a new prompt never shows the previous turn's review the runtime still answers with", async (t) => {
  const { render, answer, bar } = mount(t);
  const earlier = [
    { kind: 'user', id: 'turn-1', text: 'First' },
    edit('earlier'),
    { kind: 'turndone', id: 'done-1' },
    { kind: 'user', id: 'turn-2', text: 'Second' },
    { kind: 'status', id: 'thinking', status: 'Thinking' },
  ];
  const changed = { files: [{ path: 'a.txt', status: 'M', additions: 2, deletions: 0 }] };
  await render(earlier, true);
  await answer({ ...changed, snapshotKind: 'scoped', checkpointId: 'turn-1' });
  assert.equal(bar(), null);

  await render([...earlier, edit('current')], true);
  await answer({ ...changed, checkpointId: 'turn-2' });
  assert.ok(bar(), "the current turn's own review shows");
});

test('entering an idle session shows no estimated bar before its first read answers', async (t) => {
  const { render, answer, bar, entryPending, requests } = mount(t, 'sess-review-entry-empty');
  await render([prompt, edit('outside-worktree')], false);
  assert.equal(bar(), null, 'the transcript estimate is not painted on entry');
  assert.ok(entryPending(), 'the entry marks itself undecided for the reveal gate');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].args[0].refresh, false, 'the held snapshot is asked first');
  await answer();
  assert.equal(bar(), null, 'an empty authoritative review never shows the estimate');
  assert.equal(entryPending(), false);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].args[0].refresh, true, 'the fresh worktree read follows');
  await answer();
});

test('entering a session answered from its turn record reads once, collapsed as a summary', async (t) => {
  const { render, answer, bar, entryPending, pending, requests } = mount(t, 'sess-review-entry-recorded');
  await render([prompt, edit('recorded')], false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].args[0].summary, true, 'the collapsed bar asks for files and counts only');
  await answer({
    snapshotKind: 'scoped',
    reason: 'recorded',
    patchOmitted: true,
    files: [{ path: 'a.txt', status: 'M', additions: 2, deletions: 0 }],
  });
  assert.ok(bar());
  assert.equal(entryPending(), false);
  assert.equal(pending.length, 0);
  assert.equal(requests.length, 1, 'the refreshing read would compute the same recorded review again');
});

test('expanding during a recorded summary requests the full patch immediately after it', async (t) => {
  const { dom, render, answer, pending, requests } = mount(t, 'sess-recorded-expansion');
  const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after';
  const items = [prompt, { ...edit('first'), uiDiff: patch }];
  await render(items, false, false);
  await render(items, false, true);
  assert.equal(requests[0].args[0].summary, true);
  await act(async () => dom.window.document.querySelector('.turn-review-summary').click());
  assert.equal(requests.length, 1, 'the full read waits for the summary, not a second concurrent Git diff');
  await answer({
    snapshotKind: 'scoped',
    reason: 'recorded',
    patchOmitted: true,
    files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }],
  });
  assert.equal(requests.length, 2, 'expansion is not discarded as a duplicate summary');
  assert.equal(requests[1].args[0].summary, undefined);
  await answer({ snapshotKind: 'scoped', reason: 'recorded', patch });
  assert.equal(pending.length, 0);
  assert.equal(requests.length, 2);
});

test('an entered session with real changes shows its bar once the first read answers', async (t) => {
  const { render, answer, bar, requests } = mount(t, 'sess-review-entry-changed');
  await render([prompt, edit('first')], false);
  assert.equal(bar(), null);
  await answer({ files: [{ path: 'a.txt', status: 'M', additions: 2, deletions: 0 }] });
  assert.ok(bar());
  assert.equal(requests.length, 2);
  await answer({ files: [{ path: 'a.txt', status: 'M', additions: 2, deletions: 0 }] });
});

test('a slow first read never releases an estimated bar before its empty authoritative answer', async (t) => {
  const { render, answer, bar, entryPending } = mount(t, 'sess-review-entry-slow');
  const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after';
  await render([prompt, { ...edit('slow'), uiDiff: patch }], false);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 650)));
  assert.equal(bar(), null, 'a slow read must not paint the transcript estimate');
  assert.ok(entryPending(), 'the conversation, not a shorter review timer, owns the reveal deadline');
  await answer();
  assert.equal(bar(), null, 'the authoritative empty answer leaves the dock unchanged');
  assert.equal(entryPending(), false);
  await answer();
});

for (const hasChanges of [true, false]) {
  test(`first focus retains an already displayed review until its ${hasChanges ? 'unchanged' : 'empty'} answer`, async (t) => {
    const { render, answer, bar, entryPending, pending, requests } = mount(t, `review-first-focus-${hasChanges}`);
    const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after';
    const items = [prompt, { ...edit('focus'), uiDiff: patch }];
    await render(items, false, false);
    const displayed = bar();
    assert.ok(displayed);
    assert.equal(requests.length, 0, 'an unfocused pane does not start background capability reads');
    await render(items, false, true);
    assert.equal(requests.length, 1);
    assert.equal(bar(), displayed, 'first focus must not retract the already painted review');
    assert.equal(entryPending(), false);
    await render(items, false, false);
    assert.equal(bar(), displayed, 'blurring during the read keeps the same review');
    await answer({
      checkpointId: 'prompt',
      files: hasChanges ? [{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }] : [],
    });
    assert.equal(pending.length, 0);
    assert.equal(bar(), hasChanges ? displayed : null, 'only an authoritative content change removes the bar');
  });
}

test('blurring a first foreground read never reveals a temporary transcript estimate', async (t) => {
  const { render, answer, bar, entryPending, pending } = mount(t, 'review-entry-blur');
  const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after';
  const items = [prompt, { ...edit('blur'), uiDiff: patch }];
  await render(items, false, true);
  assert.equal(bar(), null);
  assert.equal(entryPending(), true);
  await render(items, false, false);
  assert.equal(bar(), null, 'blur cannot turn an undecided entry into a visible estimate');
  assert.equal(entryPending(), true);
  await answer();
  await answer();
  assert.equal(pending.length, 0);
  assert.equal(entryPending(), false);
  assert.equal(bar(), null);
  await render(items, false, true);
  assert.equal(bar(), null);
  await answer();
  assert.equal(bar(), null);
});

test('a review tag is only sent while the review it names is still cached', async (t) => {
  const { render, answer, requests } = mount(t);
  const tagged = { kind: 'user', id: 'tagged', text: 'Tagged' };
  const etag = 'a'.repeat(32);
  await render([tagged, edit('first')], true);
  await answer({ etag });
  await render([tagged, edit('first'), edit('second')], true);
  assert.equal(requests.at(-1).args[0].known, etag);
  await answer({ etag });

  _runIdleReclaimForTest();
  await render([tagged, edit('first'), edit('second'), edit('third')], true);
  assert.equal(requests.at(-1).args[0].known, undefined, 'a dropped review is read in full again');
  await answer();
});
