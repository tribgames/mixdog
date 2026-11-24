import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useSessionLaneRead } from './use-session-lane-read.ts';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store.ts';

/** A pane's read state over the shared lane store, as PaneConversation wires it; `fire` runs the armed watch. */
async function mountPane(t, read, prepare) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  prepare?.();
  const timers = new Map();
  let timerId = 0;
  dom.window.setTimeout = (callback) => {
    timers.set(++timerId, callback);
    return timerId;
  };
  dom.window.clearTimeout = (id) => timers.delete(id);
  // The store notifies a pane of a frame that changes nothing urgent on the next animation frame.
  const frames = [];
  const priorFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  t.after(() => {
    globalThis.requestAnimationFrame = priorFrame;
  });
  function Pane() {
    const lane = useSessionLane('s1');
    const state = useSessionLaneRead({
      sessionId: 's1',
      hasLane: lane !== null && lane.transcriptPreview !== true,
      hidden: false,
      read,
      reconcileOnMount: true,
    });
    return React.createElement(
      'div',
      null,
      React.createElement('p', null, lane?.items?.map((row) => row.id).join(',') ?? ''),
      state.readUnavailable
        ? React.createElement('button', { type: 'button', onClick: state.retryRead }, 'Retry')
        : null
    );
  }
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    defaultSessionLaneStore.clear();
    restore();
  });
  await act(async () => root.render(React.createElement(Pane)));
  return {
    timers,
    land: (update) =>
      act(async () => {
        defaultSessionLaneStore.apply(update);
        for (const callback of frames.splice(0)) callback(0);
      }),
    fire: () =>
      act(async () => {
        for (const callback of [...timers.values()]) callback();
      }),
    shown: () => document.querySelector('p').textContent,
    retry: () => document.querySelector('button'),
  };
}
const liveFrame = (rows) => ({
  sessionId: 's1',
  frameSource: 'live',
  snapshot: { sessionId: 's1', items: rows.map((id) => ({ id, role: 'user' })) },
});

test('the watch ends the read it covers, and Retry asks again with a wait of its own', async (t) => {
  const asked = [];
  const pane = await mountPane(t, (_sessionId, options) => {
    asked.push(options);
    return new Promise(() => {});
  });
  assert.equal(asked.length, 1);
  assert.deepEqual(
    [asked[0].signal.aborted, asked[0].retry],
    [false, undefined],
    'the read on mount is an ordinary one'
  );
  await pane.fire();
  assert.equal(asked[0].signal.aborted, true, 'the read that never produced a lane is no longer waited for');
  assert.equal(pane.retry()?.textContent, 'Retry');
  await act(async () => pane.retry().click());
  assert.equal(asked.length, 2, 'Retry is a new read');
  assert.deepEqual([asked[1].signal.aborted, asked[1].retry], [false, true], 'and is told apart as the retry');
  assert.equal(pane.retry(), null);
});

test('the read on mount reaches the host as an ordinary read, and Retry as a retry', async (t) => {
  const { requestSessionRead } = await import('./session-read-request.ts');
  const reads = [];
  const pane = await mountPane(t, requestSessionRead, () => {
    window.mixdogDesktop = {
      prefetchSession: (...args) => {
        reads.push(args[3]);
        return new Promise(() => {});
      },
    };
  });
  assert.deepEqual(reads, [undefined]);
  await pane.fire();
  await act(async () => pane.retry().click());
  assert.deepEqual(reads, [undefined, { retry: true }]);
});

test('a healthy reconnect leaves the rows above the restored tail in place', async (t) => {
  const pane = await mountPane(t, () => new Promise(() => {}));
  await pane.land(liveFrame(['old', 'visible', 'tail']));
  assert.equal(pane.shown(), 'old,visible,tail');
  // The host's mark of its restore, then the restored tail.
  await pane.land({
    sessionId: 's1',
    frameSource: 'replay',
    snapshot: { ...liveFrame(['visible', 'tail']).snapshot, restoreOwed: true },
  });
  assert.equal(pane.shown(), 'old,visible,tail');
  assert.equal(defaultSessionLaneStore.get('s1').restoreOwed, true);
  assert.equal(pane.timers.size, 1, 'the restore is under the pane watch meanwhile');
  await pane.land(liveFrame(['visible', 'tail']));
  assert.equal(pane.shown(), 'old,visible,tail', 'the row the user was reading is still there');
  assert.equal(defaultSessionLaneStore.get('s1').restoreOwed, undefined);
  assert.equal(pane.timers.size, 0);
  assert.equal(pane.retry(), null);
});

test('a restore that stalls over a shown transcript is surfaced as unavailable with Retry, not left as stale content', async (t) => {
  const reads = [];
  const pane = await mountPane(t, (_sessionId, options) => {
    reads.push(options.retry === true);
    return new Promise(() => {});
  });
  await pane.land(liveFrame(['m1']));
  assert.equal(pane.shown(), 'm1');
  assert.equal(pane.timers.size, 0, 'a live lane is not watched');
  reads.length = 0;

  // The host's mark of a restore it has not finished (session-lane.ts): the held state, with `restoreOwed`.
  await pane.land({
    sessionId: 's1',
    frameSource: 'replay',
    snapshot: { ...liveFrame(['m1']).snapshot, restoreOwed: true },
  });
  assert.equal(pane.shown(), 'm1', 'the transcript stays on screen meanwhile');
  assert.equal(pane.timers.size, 1, 'the restore is under the pane watch');
  assert.deepEqual(reads, [], 'the pane asks for nothing while the host restores');
  await pane.fire();
  assert.equal(pane.retry()?.textContent, 'Retry');
  await act(async () => pane.retry().click());
  assert.deepEqual(reads, [true], 'Retry asks the host for a new attach');

  await pane.land(liveFrame(['m1', 'm2']));
  assert.equal(pane.shown(), 'm1,m2');
  assert.equal(pane.retry(), null);
  assert.equal(pane.timers.size, 0);
});

for (const outcome of ['accepted-without-frame', 'pending', 'rejected', 'resume-owned']) {
  test(`cold pane exposes retry instead of waiting forever: ${outcome}`, async () => {
    const { dom, restore } = installTestDom(null, {
      html: '<!doctype html><div id="root"></div>',
      jsdom: { url: 'about:blank' },
    });
    const timers = new Map();
    let timerId = 0;
    dom.window.setTimeout = (callback) => {
      timers.set(++timerId, callback);
      return timerId;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    let reads = 0;
    const read = () => {
      reads += 1;
      if (outcome === 'pending') return new Promise(() => {});
      if (outcome === 'rejected') return Promise.reject(new Error('session timeout'));
      return Promise.resolve(true);
    };
    function Pane({ hasLane = false, hidden = false, sessionId = 'restored' }) {
      const state = useSessionLaneRead({
        sessionId,
        hasLane,
        hidden,
        read,
        reconcileOnMount: outcome !== 'resume-owned',
      });
      if (state.readUnavailable)
        return React.createElement('button', { type: 'button', onClick: state.retryRead }, 'Retry');
      return React.createElement('span', null, hasLane ? 'Transcript restored' : 'Loading');
    }
    const root = createRoot(document.getElementById('root'));
    const render = async (props = {}) => act(async () => root.render(React.createElement(Pane, props)));
    try {
      await render();
      assert.equal(reads, outcome === 'resume-owned' ? 0 : 1);
      await act(async () => {
        for (const callback of [...timers.values()]) callback();
      });
      assert.equal(document.querySelector('button')?.textContent, 'Retry');
      await act(async () => document.querySelector('button').click());
      assert.equal(reads, outcome === 'resume-owned' ? 1 : 2);
      // A late lane still wins, even if its request never settled.
      await render({ hasLane: true });
      assert.equal(document.getElementById('root').textContent, 'Transcript restored');
      assert.equal(timers.size, 0);
      // Retired panes and drafts must not acquire a stale error.
      await render({ sessionId: 'other', hidden: true });
      assert.equal(document.querySelector('button'), null);
      assert.equal(timers.size, 0);
      await render({ sessionId: '' });
      assert.equal(document.querySelector('button'), null);
      assert.equal(timers.size, 0);
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });
}
