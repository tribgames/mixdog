// A finished multi-step turn folds the work before its final answer into one
// row; 1-step, streaming, failed and cancelled turns render as before.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
  appendLiveTranscriptRows,
  foldTurnWork,
  projectSettledTranscriptRows,
  turnWorkSpans,
} from './transcript-rows.ts';
import { toggleWorkFold, useTurnWorkFolds } from './use-turn-work-folds.ts';
import { workFoldLabel } from './transcript-work-fold.tsx';
import { turnEndToolItems } from './agent-chat-place.ts';
import { transcriptTurnKeys } from './renderer-logic.mjs';

const tool = (id, extra = {}) => ({
  kind: 'tool',
  id,
  name: 'shell',
  args: { command: 'ls' },
  result: 'ok',
  completedAt: 1,
  ...extra,
});
const user = { kind: 'user', id: 'u1', text: 'fix it' };
const work = [
  { kind: 'assistant', id: 'a1', text: 'Looking first.' },
  tool('t1'),
  tool('t2'),
  { kind: 'assistant', id: 'a2', text: 'Found it; fixing.' },
  tool('t3'),
];
const answer = { kind: 'assistant', id: 'a3', text: 'Fixed.' };
const done = { kind: 'turndone', id: 'd1', status: 'complete', elapsedMs: 1000 };

function settled(items, failed = []) {
  const turnKeys = transcriptTurnKeys(items);
  return projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys, failedTurns: new Set(failed) });
}
const rowsOf = (items, failed) => settled(items, failed).rows;
const keys = (rows) => rows.map((row) => row.key);
const foldAll =
  (open = false) =>
  () => ({ fold: true, open });

test('a finished turn with two steps folds its work into one row above the final answer', () => {
  const rows = rowsOf([user, ...work, answer, done]);
  const spans = turnWorkSpans(rows);
  assert.deepEqual(spans, [{ key: 's:a3:work', turnKey: 'turn:u1', runKey: 'turn:u1', start: 1, end: 4, steps: 2 }]);
  const folded = foldTurnWork(rows, spans, foldAll());
  assert.deepEqual(keys(folded), ['s:u1', 's:a3:work', 's:a3']);
  const fold = folded[1];
  assert.equal(fold._tag, 'WorkFold');
  assert.equal(fold.open, false);
  assert.deepEqual(
    fold.items.map((item) => item.id),
    ['t1', 't2', 't3']
  );
  // The turn's end still sees every tool round (its visualize and changes cards).
  assert.deepEqual(
    turnEndToolItems(folded, 2).map((item) => item.id),
    ['t1', 't2', 't3']
  );
});

test('an opened fold is followed by the work, marked as work', () => {
  const rows = rowsOf([user, ...work, answer, done]);
  const opened = foldTurnWork(rows, turnWorkSpans(rows), foldAll(true));
  assert.deepEqual(keys(opened), ['s:u1', 's:a3:work', ...keys(rows.slice(1))]);
  assert.deepEqual(opened[1].folded, []);
  assert.ok(opened.slice(2, 6).every((row) => row.work === true));
  assert.equal(opened.at(-1).work, undefined);
});

test('1-step, no-final-text, streaming, failed and cancelled turns do not fold', () => {
  assert.deepEqual(turnWorkSpans(rowsOf([user, tool('t1'), answer, done])), []);
  // The turn ends in a tool round: no final text after it.
  assert.deepEqual(turnWorkSpans(rowsOf([user, ...work, done])), []);
  assert.deepEqual(turnWorkSpans(rowsOf([user, ...work, answer, done], ['turn:u1'])), []);
  assert.deepEqual(turnWorkSpans(rowsOf([user, ...work, answer, { ...done, status: 'cancelled' }])), []);
  const streaming = appendLiveTranscriptRows({
    sessionKey: 's',
    settled: settled([user, ...work]),
    liveItem: { ...answer, streaming: true, text: 'Fixed' },
    thinking: true,
    turnRunning: true,
  });
  assert.deepEqual(turnWorkSpans(streaming), []);
});

// A message the model read while the turn ran starts a new turn key; the run
// ends with one completion (attempt-keyed from the steering message on).
const steer = { kind: 'user', id: 'st1', text: 'also check the docs', steered: true };
const attemptDone = { ...done, attemptId: 'A' };
const withoutGaps = (rows) => keys(rows.filter((row) => row._tag !== 'TurnGap'));

test('work before a steering message folds with the run, the steering message stays in view', () => {
  const rows = rowsOf([user, ...work, steer, answer, attemptDone]);
  const folded = foldTurnWork(rows, turnWorkSpans(rows), foldAll());
  assert.deepEqual(withoutGaps(folded), ['s:u1', 's:a3:work', 's:st1', 's:a3']);
  assert.deepEqual(
    folded.find((row) => row._tag === 'WorkFold').items.map((item) => item.id),
    ['t1', 't2', 't3']
  );
});

test('work on both sides of a steering message folds apart, each fold with its own counts', () => {
  const items = [
    user,
    { kind: 'assistant', id: 'a1', text: 'Looking first.' },
    tool('t1'),
    tool('t2'),
    steer,
    { kind: 'assistant', id: 'a2', text: 'Checking the docs too.' },
    tool('t3'),
    tool('t4', { exitErrorCount: 1 }),
    answer,
    attemptDone,
  ];
  const rows = rowsOf(items);
  const folded = foldTurnWork(rows, turnWorkSpans(rows), foldAll());
  assert.deepEqual(withoutGaps(folded), ['s:u1', 's:a3:work:0', 's:st1', 's:a3:work', 's:a3']);
  const folds = folded.filter((row) => row._tag === 'WorkFold');
  assert.deepEqual(
    folds.map((fold) => [fold.steps, fold.items.map((item) => item.id), workFoldLabel(fold.steps, fold.items)]),
    [
      [1, ['t1', 't2'], '1 step · Used tools 2 times'],
      [1, ['t3', 't4'], '1 step · Used tools 2 times · 1 failed'],
    ]
  );
});

test('interim text with no tool round beside it stays unfolded; the tool segment folds', () => {
  const items = [
    user,
    { kind: 'assistant', id: 'a1', text: 'Looking first.' },
    steer,
    tool('t1'),
    { kind: 'assistant', id: 'a2', text: 'One more check.' },
    tool('t2'),
    answer,
    attemptDone,
  ];
  const rows = rowsOf(items);
  const folded = foldTurnWork(rows, turnWorkSpans(rows), foldAll());
  assert.deepEqual(withoutGaps(folded), ['s:u1', 's:a1', 's:st1', 's:a3:work', 's:a3']);
  assert.equal(
    folded.find((row) => row.key === 's:a1'),
    rows.find((row) => row.key === 's:a1')
  );
  const fold = folded.find((row) => row._tag === 'WorkFold');
  assert.deepEqual([fold.steps, fold.items.map((item) => item.id)], [2, ['t1', 't2']]);
});

test('the fold label counts steps and calls, and failures only when some call failed', () => {
  assert.equal(workFoldLabel(2, [tool('t1'), tool('t2'), tool('t3')]), '2 steps · Used tools 3 times');
  assert.equal(
    workFoldLabel(2, [tool('t1'), tool('t2', { exitErrorCount: 1 }), tool('t3')]),
    '2 steps · Used tools 3 times · 1 failed'
  );
});

async function withHook(viewportHtml, run) {
  const dom = new JSDOM(`<div id="viewport">${viewportHtml}</div><div id="root"></div>`, {
    url: 'http://localhost/',
  });
  const names = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const viewport = { current: dom.window.document.getElementById('viewport') };
  const root = createRoot(dom.window.document.getElementById('root'));
  let shown = null;
  function Probe({ rows, following }) {
    shown = useTurnWorkFolds({ rows, enabled: true, following, viewport });
    return null;
  }
  const render = async (rows, following) => {
    await act(async () => root.render(React.createElement(Probe, { rows, following })));
    return keys(shown);
  };
  try {
    await run(render);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

const runningRows = () => rowsOf([user, ...work, answer]);
const finishedRows = () => rowsOf([user, ...work, answer, done]);
const inView = (key, offscreen = false) =>
  `<div class="transcript-virtual-row" data-timeline-key="${key}"${offscreen ? ' data-offscreen="true"' : ''}></div>`;

test('a turn finishing under a reader scrolled up to its work waits for the bottom', async () => {
  await withHook(inView('s:a1') + inView('s:t1:tool-activity'), async (render) => {
    await render(runningRows(), false);
    assert.equal((await render(finishedRows(), false)).length, 6, 'the work stays under the reader');
    assert.deepEqual(await render(finishedRows(), true), ['s:u1', 's:a3:work', 's:a3']);
  });
});

test('a turn whose key changes as it ends still waits for a reader scrolled up to its work', async () => {
  await withHook(inView('s:a1'), async (render) => {
    await render(rowsOf([user, ...work, answer]), false);
    assert.equal((await render(rowsOf([user, ...work, answer, attemptDone]), false)).length, 6);
    assert.deepEqual(await render(rowsOf([user, ...work, answer, attemptDone]), true), ['s:u1', 's:a3:work', 's:a3']);
  });
});

test('a held turn folds once the next message starts another turn', async () => {
  await withHook(inView('s:a2'), async (render) => {
    await render(runningRows(), false);
    await render(finishedRows(), false);
    const next = appendLiveTranscriptRows({
      sessionKey: 's',
      settled: settled([user, ...work, answer, done]),
      pendingItems: [{ kind: 'user', id: 'u2', text: 'thanks', pending: true }],
    });
    assert.deepEqual((await render(next, false)).slice(0, 3), ['s:u1', 's:a3:work', 's:a3']);
  });
});

test('a turn finishing with none of its work in view folds at once', async () => {
  await withHook(inView('s:a3') + inView('s:a1', true), async (render) => {
    await render(runningRows(), false);
    assert.deepEqual(await render(finishedRows(), false), ['s:u1', 's:a3:work', 's:a3']);
  });
});

test('a turn first seen finished (history) folds at once, and toggling opens it', async () => {
  await withHook(inView('s:a1'), async (render) => {
    assert.deepEqual(await render(finishedRows(), false), ['s:u1', 's:a3:work', 's:a3']);
    await act(async () => toggleWorkFold('s:a3:work'));
    assert.equal((await render(finishedRows(), false)).length, 7);
    await act(async () => toggleWorkFold('s:a3:work'));
    assert.equal((await render(finishedRows(), false)).length, 3);
  });
});
