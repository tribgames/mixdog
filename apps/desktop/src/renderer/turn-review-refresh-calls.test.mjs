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

test("switching sessions in a pane never queues the entry read behind the previous session's read", async (t) => {
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
  const render = (sessionId, busy) =>
    act(async () =>
      root.render(
        React.createElement(TurnReviewBar, { items: [prompt, edit(sessionId)], sessionId, active: true, busy })
      )
    );
  const reply = (index) =>
    act(async () =>
      pending[index]({
        value: { supported: true, authoritative: true, snapshotKind: 'worktree', patch: '', files: [], agents: [] },
      })
    );
  const entryPending = () => Boolean(dom.window.document.querySelector('[data-entry-pending]'));

  await render('sess-switch-from', true);
  assert.equal(requests.length, 1, "the outgoing session's worktree read is in flight");
  await render('sess-switch-to', false);
  assert.equal(requests.length, 2, 'the incoming entry read is sent at once');
  assert.equal(requests[1].sessionId, 'sess-switch-to');
  assert.equal(requests[1].args[0].refresh, false);
  assert.ok(entryPending());
  await reply(1);
  assert.equal(entryPending(), false, 'the entry settles without waiting for the outgoing read');
  assert.equal(requests.length, 3, "the incoming session's fresh read follows its entry read");
  assert.equal(requests[2].sessionId, 'sess-switch-to');
  await reply(0);
  assert.equal(requests.length, 3, 'the superseded read drains nothing for the incoming session');
  await reply(2);
});

test('re-entering a session never lets its superseded read overwrite the newer answer', async (t) => {
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
  const render = (sessionId, busy) =>
    act(async () =>
      root.render(React.createElement(TurnReviewBar, { items: [prompt, edit('same')], sessionId, active: true, busy }))
    );
  const reply = (index, additions) =>
    act(async () =>
      pending[index]({
        value: {
          supported: true,
          authoritative: true,
          snapshotKind: 'worktree',
          patch: '',
          agents: [],
          files: [{ path: 'a.txt', status: 'M', additions, deletions: 0 }],
        },
      })
    );
  const text = () => dom.window.document.querySelector('.turn-review-bar')?.textContent || '';

  await render('sess-reenter-a', true);
  await render('sess-reenter-b', true);
  await render('sess-reenter-a', true);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].sessionId, 'sess-reenter-a');
  await reply(2, 5);
  assert.match(text(), /\+5/);
  await reply(0, 1);
  assert.match(text(), /\+5/, 'the older read of the same session is dropped');
  assert.doesNotMatch(text(), /\+1/);
  await reply(1, 2);
  assert.match(text(), /\+5/);
});

test("an outgoing session's answer never suppresses the incoming session's identical answer", async (t) => {
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
  const render = (sessionId, extra = []) =>
    act(async () =>
      root.render(
        React.createElement(TurnReviewBar, {
          items: [prompt, edit('same'), ...extra],
          sessionId,
          active: true,
          busy: true,
        })
      )
    );
  const reply = (index, files) =>
    act(async () =>
      pending[index]({
        value: { supported: true, authoritative: true, snapshotKind: 'worktree', patch: '', agents: [], files },
      })
    );
  const text = () => dom.window.document.querySelector('.turn-review-bar')?.textContent || '';

  await render('sess-sig-a');
  await render('sess-sig-b');
  assert.equal(requests.length, 2);
  await reply(1, [{ path: 'a.txt', status: 'M', additions: 5, deletions: 0 }]);
  assert.match(text(), /\+5/);
  await render('sess-sig-b', [edit('later')]);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].sessionId, 'sess-sig-b');
  // The outgoing session answers empty first, then the incoming one does.
  await reply(0, []);
  await reply(2, []);
  assert.doesNotMatch(text(), /\+5/, 'the incoming session shows its own empty answer');
});

test('an idle backoff read answered from the cached summary is followed by a refreshing read', async (t) => {
  const { dom, render, answer, requests } = mount(t, 'sess-review-idle-cached');
  const timers = [];
  const setTimeoutNative = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (callback, ms, ...rest) =>
    ms >= 6_000 ? timers.push(callback) : setTimeoutNative(callback, ms, ...rest);
  const changed = { files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }] };
  await render([prompt, edit('first')], false);
  await answer({ ...changed, snapshotKind: 'scoped', reason: 'cached', patchOmitted: true });
  assert.equal(requests.at(-1).args[0].refresh, true, 'the entry refresh follows the cached summary');
  await answer({ ...changed, snapshotKind: 'scoped', reason: 'recorded', patchOmitted: true });
  const settled = requests.length;

  assert.ok(timers.length > 0, 'the idle backoff is scheduled');
  await act(async () => timers.shift()());
  assert.equal(requests.length, settled + 1);
  assert.equal(requests.at(-1).args[0].refresh, false);
  await answer({ ...changed, snapshotKind: 'scoped', reason: 'cached', patchOmitted: true });
  assert.equal(requests.length, settled + 2, 'a cached backoff answer asks the worktree again');
  assert.equal(requests.at(-1).args[0].refresh, true);
  await answer({ ...changed, snapshotKind: 'scoped', reason: 'recorded', patchOmitted: true });
});

test('a cached summary is never named as known, so a failed refresh is retried by the next backoff read', async (t) => {
  const { dom, render, answer, pending, requests } = mount(t, 'sess-review-cached-tag');
  const timers = [];
  const setTimeoutNative = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (callback, ms, ...rest) =>
    ms >= 6_000 ? timers.push(callback) : setTimeoutNative(callback, ms, ...rest);
  const cached = {
    files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }],
    snapshotKind: 'scoped',
    reason: 'cached',
    patchOmitted: true,
    etag: 'c'.repeat(32),
  };
  await render([prompt, edit('first')], false);
  await answer(cached);
  assert.equal(requests.at(-1).args[0].refresh, true);
  // The refreshing read fails.
  await act(async () => pending.shift()(Promise.reject(new Error('transient'))));
  await act(async () => timers.shift()());
  assert.equal(requests.at(-1).args[0].refresh, false);
  assert.equal(requests.at(-1).args[0].known, undefined, 'the cached tag is not offered for an unchanged reply');
  await answer(cached);
  assert.equal(requests.at(-1).args[0].refresh, true, 'the refresh is retried');
  await answer({ ...cached, reason: 'recorded', etag: undefined });
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

test('running-turn boundaries and the interval timer read in the background; opening and idle reads capture now', async (t) => {
  const { dom, render, answer, requests } = mount(t, 'sess-review-poll-kind');
  const timers = [];
  dom.window.setInterval = (callback) => timers.push(callback);
  dom.window.clearInterval = () => {};
  const tick = () => act(async () => timers.at(-1)());
  const items = [prompt, edit('first')];
  const changed = { files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }] };

  await render(items, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].args[0].poll, 'background', 'a running turn tool-boundary read respects the capture gap');
  assert.equal(requests[0].args[0].refresh, true);
  await answer(changed);

  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].args[0].poll, 'background', 'the busy timer polls in the background');
  assert.equal(requests[1].args[0].summary, true, 'a collapsed bar polls for a summary');
  await answer(changed);

  await act(async () => dom.window.document.querySelector('.turn-review-summary').click());
  assert.equal(requests.length, 3);
  assert.equal(requests[2].args[0].poll, undefined, 'opening the review reads in the foreground');
  assert.equal(requests[2].args[0].summary, undefined);
  await answer(changed);

  await tick();
  assert.equal(requests.length, 4);
  assert.equal(requests[3].args[0].poll, 'background');
  assert.equal(requests[3].args[0].summary, undefined, 'an open review polls for its patch');
  await answer(changed);

  // A boundary queued behind a poll stays a background read.
  await tick();
  await render([...items, edit('second')], true);
  assert.equal(requests.length, 5);
  await answer(changed);
  assert.equal(requests.length, 6);
  assert.equal(requests[5].args[0].poll, 'background');
  await answer(changed);

  // The turn ending is the authoritative boundary: it captures now.
  await render([...items, edit('second')], false);
  assert.equal(requests.at(-1).args[0].poll, undefined);
  assert.equal(requests.at(-1).args[0].refresh, true);
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
