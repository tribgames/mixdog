import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['HTMLElement', 'Element', 'Node', 'Event'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { prepareSessionOpen, finalizeSessionOpen, currentOpenToken, rowsMountedAtEnd } = await import(
  './session-open-intent.ts'
);
const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
const { useTurnChanges, resetTurnChangesCache, bumpTurnChangesEpoch } = await import('./turn-changes-model.ts');
const { leadReviewSnapshotKindCache } = await import('./turn-review-cache.ts');
const { transcriptRowHeightStore } = await import('./transcript-row-estimates.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const turns = (count) =>
  Array.from({ length: count }, (_, n) => [
    { id: `u${n}`, kind: 'user', text: `ask ${n}`, checkpointId: `cp${n}` },
    { id: `a${n}`, kind: 'assistant', text: `- reply ${n}\n- more` },
    { id: `t${n}`, kind: 'turndone', checkpointId: `cp${n}` },
  ]).flat();

let hold = null;

function install(items) {
  const reads = [];
  window.mixdogDesktop = {
    prefetchSession: async (sessionId) => {
      defaultSessionLaneStore.apply({ sessionId, snapshot: { sessionId, items } });
      return true;
    },
    invokeCapability: async ({ capability, args }) => {
      reads.push([capability, args[0].checkpointId]);
      if (capability === 'getTurnReviewDiff') {
        return { value: { authoritative: true, snapshotKind: 'turn', checkpointId: '', files: [{ path: 'a.txt' }] } };
      }
      if (hold) await hold;
      return { value: { status: 'none', checkpointId: args[0].checkpointId, revision: 1, root: '', files: [] } };
    },
  };
  return reads;
}

// What the card's row paints in its FIRST commit: `unread` marks the row
// pending (data-transcript-pending), which holds the transcript's reveal.
async function firstCommit(sessionId, checkpointId, boundary) {
  const seen = [];
  function Card() {
    const { unread } = useTurnChanges({ sessionId, checkpointId, boundary, enabled: true });
    seen.push(unread);
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  await act(async () => root.render(React.createElement(Card)));
  await act(async () => root.unmount());
  return seen[0];
}

test('the intent to open a session reads its rows changed-files cards once, before the click commits', async (t) => {
  resetTurnChangesCache();
  const reads = install(turns(3));
  t.after(() => {
    delete window.mixdogDesktop;
    resetTurnChangesCache();
  });
  assert.equal(
    await firstCommit('s-cold', 'cp2', 't2'),
    true,
    'without the intent the card is unread in its first commit'
  );
  reads.length = 0;
  const cardReads = () => reads.filter((read) => read[0] === 'getTurnChanges').map((read) => read[1]);

  assert.equal(await prepareSessionOpen('s-intent'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Press, then focus, then the open itself: one read per card, not per call.
  await prepareSessionOpen('s-intent');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cardReads().sort(), ['cp0', 'cp1', 'cp2']);

  for (const n of [0, 1, 2]) {
    assert.equal(await firstCommit('s-intent', `cp${n}`, `t${n}`), false, `card ${n} is read in the click commit`);
  }
  assert.equal(cardReads().length, 3, 'the mounted cards joined the prefetch: no second read');
});

test('a card mounting while the intent read is in flight joins it under the card exact key: one read', async (t) => {
  resetTurnChangesCache();
  const reads = install(turns(1));
  let release;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => {
    hold = null;
    delete window.mixdogDesktop;
    resetTurnChangesCache();
  });
  await prepareSessionOpen('s-flight');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads.filter((read) => read[0] === 'getTurnChanges').length, 1, 'the intent started the read');
  const seen = [];
  function Card() {
    seen.push(useTurnChanges({ sessionId: 's-flight', checkpointId: 'cp0', boundary: 't0', enabled: true }).unread);
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  await act(async () => root.render(React.createElement(Card)));
  assert.equal(seen[0], true, 'the answer has not landed yet');
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => root.unmount());
  assert.equal(seen.at(-1), false, 'the mounted card took the prefetched answer');
  assert.equal(reads.filter((read) => read[0] === 'getTurnChanges').length, 1);
});

test('the intent also reads the island entry review once, caching it so the island mounts undecided no more', async (t) => {
  const reads = install(turns(3));
  t.after(() => {
    delete window.mixdogDesktop;
  });
  const scopeKey = 's-review:u2';
  assert.equal(leadReviewSnapshotKindCache.has(scopeKey), false);
  await prepareSessionOpen('s-review');
  await prepareSessionOpen('s-review');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads.filter((read) => read[0] === 'getTurnReviewDiff').length, 1);
  assert.equal(leadReviewSnapshotKindCache.has(scopeKey), true, 'the entry hold (use-turn-review-reads) is released');
});

test('the rows prepared are the rows the list mounts at its end: the viewport plus overscan, last row first', () => {
  const items = turns(60);
  const store = transcriptRowHeightStore();
  const rows = items
    .filter((item) => item.kind === 'assistant')
    .map((item) => ({ _tag: 'AssistantPart', key: item.id, turnKey: item.id, item }));
  const mounted = rowsMountedAtEnd('s-rows', rows);
  assert.equal(mounted[0], rows.at(-1));
  let covered = 0;
  let expected = 0;
  let overscan = 0;
  for (let index = rows.length - 1; index >= 0 && overscan < 10; index -= 1) {
    expected += 1;
    if (covered >= window.innerHeight) overscan += 1;
    else covered += store.estimate(rows[index], window.innerWidth, 'coding');
  }
  assert.equal(mounted.length, expected);
  assert.ok(mounted.length < rows.length, 'not the whole transcript');
});

test('the lane landing a moment after the read answers still gets its content prepared', async (t) => {
  resetTurnChangesCache();
  const reads = install(turns(2));
  const lateLane = window.mixdogDesktop.prefetchSession;
  window.mixdogDesktop.prefetchSession = async (sessionId) => {
    setTimeout(() => lateLane(sessionId), 5);
    return true;
  };
  t.after(() => {
    delete window.mixdogDesktop;
    resetTurnChangesCache();
  });
  assert.equal(await prepareSessionOpen('s-late'), true);
  assert.equal(defaultSessionLaneStore.get('s-late'), null, 'the read answered before the lane exists');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    reads
      .filter((read) => read[0] === 'getTurnChanges')
      .map((read) => read[1])
      .sort(),
    ['cp0', 'cp1']
  );
});

// The lane wait: the read is acknowledged first, the lane delivered later.
function ackFirst(items) {
  defaultSessionLaneStore.clear();
  const reads = install(items);
  const calls = [];
  window.mixdogDesktop.prefetchSession = async (sessionId) => {
    calls.push(sessionId);
    return true;
  };
  const deliver = (sessionId, rows = items) =>
    defaultSessionLaneStore.apply({ sessionId, snapshot: { sessionId, items: rows } });
  let subscribed = 0;
  let released = 0;
  const subscribe = defaultSessionLaneStore.subscribe;
  defaultSessionLaneStore.subscribe = (sessionId, listener) => {
    subscribed += 1;
    const stop = subscribe.call(defaultSessionLaneStore, sessionId, listener);
    return () => {
      released += 1;
      stop();
    };
  };
  const waits = () => ({ subscribed, released, open: subscribed - released });
  const restore = () => {
    defaultSessionLaneStore.subscribe = subscribe;
    for (const id of ['w-1', 'w-2', 'w-3']) finalizeSessionOpen(currentOpenToken(id));
    delete window.mixdogDesktop;
    resetTurnChangesCache();
  };
  const cardReads = () => reads.filter((read) => read[0] === 'getTurnChanges').length;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { calls, deliver, waits, restore, cardReads, tick };
}

test('repeated presses on one session share one lane wait, ended by the lane delivery', async (t) => {
  resetTurnChangesCache();
  const w = ackFirst(turns(2));
  t.after(w.restore);
  await Promise.all([prepareSessionOpen('w-1'), prepareSessionOpen('w-1'), prepareSessionOpen('w-1')]);
  await w.tick();
  assert.equal(w.calls.length, 1, 'one lane read');
  assert.deepEqual(w.waits(), { subscribed: 1, released: 0, open: 1 }, 'one wait, still open');
  assert.equal(w.cardReads(), 0, 'nothing to prepare before the lane exists');
  await prepareSessionOpen('w-1');
  await w.tick();
  assert.deepEqual(w.waits(), { subscribed: 1, released: 0, open: 1 }, 'a press during the wait joins it');
  w.deliver('w-1');
  await w.tick();
  assert.equal(w.waits().open, 0, 'the wait ended exactly on delivery');
  assert.equal(w.cardReads(), 2, 'the late lane still prepared its cards');
});

test('an empty completed lane ends the wait and prepares nothing', async (t) => {
  const w = ackFirst(turns(2));
  t.after(w.restore);
  await prepareSessionOpen('w-1');
  assert.equal(w.waits().open, 1);
  w.deliver('w-1', []);
  assert.equal(w.waits().open, 0);
  w.deliver('w-1');
  await w.tick();
  assert.equal(w.cardReads(), 0);
});

test('abandoning the intent, or starting another, ends the wait; the late lane prepares nothing', async (t) => {
  const w = ackFirst(turns(2));
  t.after(w.restore);
  await prepareSessionOpen('w-1');
  assert.equal(w.waits().open, 1);
  finalizeSessionOpen(currentOpenToken('w-2'));
  assert.equal(w.waits().open, 1, 'another session finalizing leaves this wait alone');
  finalizeSessionOpen(currentOpenToken('w-1'));
  assert.equal(w.waits().open, 0);
  w.deliver('w-1');
  await w.tick();
  assert.equal(w.cardReads(), 0, 'an abandoned intent prepares nothing');

  await prepareSessionOpen('w-2');
  assert.equal(w.waits().open, 1);
  await prepareSessionOpen('w-3');
  assert.equal(w.waits().open, 1, 'the newer intent replaced the older wait');
  assert.equal(w.waits().subscribed, 3);
  w.deliver('w-2');
  await w.tick();
  assert.equal(w.cardReads(), 0, 'the replaced intent prepares nothing');
});

test('a failed lane read ends the intent: no wait, and the next press reads again', async (t) => {
  const w = ackFirst(turns(2));
  t.after(w.restore);
  window.mixdogDesktop.prefetchSession = async (sessionId) => {
    w.calls.push(sessionId);
    return false;
  };
  assert.equal(await prepareSessionOpen('w-1'), false);
  await w.tick();
  assert.equal(w.waits().subscribed, 0, 'no wait for a lane that was refused');
  const reads = w.calls.length;
  await prepareSessionOpen('w-1');
  assert.ok(w.calls.length > reads, 'the intent was over: a new press reads again');
  w.deliver('w-1');
  await w.tick();
  assert.equal(w.cardReads(), 0);
});

test('a preparation that failed, or went out of date, is made again by the next intent', async (t) => {
  resetTurnChangesCache();
  const reads = install(turns(1));
  let failing = true;
  const answer = window.mixdogDesktop.invokeCapability;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (failing) {
      reads.push([request.capability, 'failed']);
      throw new Error('offline');
    }
    return answer(request);
  };
  t.after(() => {
    delete window.mixdogDesktop;
    resetTurnChangesCache();
  });
  const asked = (capability) => reads.filter((read) => read[0] === capability).length;
  await prepareSessionOpen('s-retry');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked('getTurnChanges'), 1);
  assert.equal(asked('getTurnReviewDiff'), 1);

  failing = false;
  await prepareSessionOpen('s-retry');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked('getTurnChanges'), 2, 'the failed card read was asked again');
  assert.equal(asked('getTurnReviewDiff'), 2, 'the failed entry review was asked again');
  assert.equal(await firstCommit('s-retry', 'cp0', 't0'), false, 'the retry reached the card');

  await prepareSessionOpen('s-retry');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked('getTurnChanges'), 2, 'answered and current: nothing is asked again');
  bumpTurnChangesEpoch('s-retry');
  await prepareSessionOpen('s-retry');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked('getTurnChanges'), 3, 'a newer epoch is prepared again');
});

test('a stale token cannot finalize a newer intent, not even one for the same session', async (t) => {
  const w = ackFirst(turns(2));
  t.after(w.restore);
  await prepareSessionOpen('w-1');
  const stale = currentOpenToken('w-1');
  assert.ok(stale > 0);
  finalizeSessionOpen(stale);
  assert.equal(w.waits().open, 0);
  await prepareSessionOpen('w-1');
  const fresh = currentOpenToken('w-1');
  assert.notEqual(fresh, stale);
  finalizeSessionOpen(stale);
  assert.equal(w.waits().open, 1, 'the old token left the new intent alone');
  finalizeSessionOpen(fresh);
  assert.equal(w.waits().open, 0);
});
