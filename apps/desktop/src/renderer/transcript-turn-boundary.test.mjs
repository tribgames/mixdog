// What stands around a turn's end, as the pane mounts it: the rows, the changed-files card and the reads the card makes.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { mountTranscriptPane } from './test-support/transcript-pane.mjs';
import { turnOf } from './conversation-turn-index.ts';
import { isRowVisuallyStreaming } from './transcript-row.tsx';
import { claimTurnPreviewEnd, turnPreviewOpenPending } from './turn-preview-model.ts';
import { resyncVisualizeStates, setVisualizePanelOnScreen } from './visualize-store.ts';

const h = React.createElement;
const settle = (ms = 20) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

const prompt = { kind: 'user', id: 'prompt', text: 'Change a file', at: 1_000 };
const reply = { kind: 'assistant', id: 'reply', text: 'Changed it.', at: 4_000 };
const done = {
  kind: 'turndone',
  id: 'done',
  status: 'done',
  verb: 'Completed',
  checkpointId: 'cp',
  finalAssistantId: 'reply',
  elapsedMs: 3_000,
  at: 4_000,
};

/** The shared pane with its turn's changes record unsealed: pending, as the core answers while the turn holds it. */
async function mountPane(t) {
  const view = await mountTranscriptPane(t);
  view.sealed = false;
  return view;
}

test('a status line a running turn leaves opens no turn: its band stays the turn’s own', async (t) => {
  const view = await mountPane(t);
  // "Compact checked": written with no time while the turn goes on.
  const checked = { kind: 'statusdone', id: 'compact', status: 'done', verb: 'Compact checked' };
  await view.render({ items: [prompt, reply], busy: true, activityAt: 1_000 });
  const before = view.tags();
  await view.render({ items: [prompt, reply, checked], busy: true, activityAt: 1_000 });
  assert.equal(view.tags().filter((tag) => tag === 'TurnGap').length, before.filter((tag) => tag === 'TurnGap').length);
  assert.equal(view.rows.at(-1)._tag, 'Thinking');
  assert.equal(view.rows.at(-1).turnKey, view.rows[0].turnKey, 'the band is still the running turn’s');
});

test('the changed-files card is read once the session is idle, not when the turn’s end is written', async (t) => {
  const view = await mountPane(t);
  await view.render({ items: [prompt, reply], busy: true, activityAt: 1_000 });
  // The end is written while the turn still holds its record (the review seal): a read now would answer `pending` and
  // leave the card to its retry.
  await view.render({ items: [prompt, reply, done], busy: true, activityAt: 1_000 });
  assert.equal(view.reads, 0, 'no read while the turn is winding down');
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  assert.equal(view.reads, 1, 'one read, at idle');
  assert.ok(view.card(), 'the card shows from that read, with no retry to wait for');
});

test('an end written before its own reply settles opens no turn under that reply', async (t) => {
  const view = await mountPane(t);
  const arriving = { ...reply, streaming: true };
  await view.render({ items: [prompt], busy: true, liveItem: arriving, activityAt: 1_000 });
  assert.deepEqual(view.tags(), ['UserMessage', 'AssistantPart', 'Thinking']);
  // The end names the reply still arriving: it is the ended turn's, not a later one's.
  await view.render({ items: [prompt, done], busy: true, liveItem: arriving, activityAt: 1_000 });
  assert.ok(!view.tags().includes('TurnGap'), 'no turn opens');
  const live = view.rows.find((row) => row._tag === 'AssistantPart' && row.live);
  assert.equal(live.turnKey, view.rows[0].turnKey, 'the reply stays in its turn');
  assert.equal(view.rows.at(-1).turnKey, view.rows[0].turnKey, 'and so does the band');
});

test('a wake with no prompt keeps the finished turn’s card while its reply streams', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  assert.ok(view.card());
  const finishedTurn = view.rows.find((row) => row._tag === 'AssistantPart').turnKey;
  // A task report starts a turn whose kickoff is hidden: the first thing of it is a reply still arriving.
  const arriving = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', streaming: true, at: 9_100 };
  await view.render({ items: [prompt, reply, done], busy: true, liveItem: arriving, activityAt: 9_000 });
  assert.deepEqual(view.tags(), ['UserMessage', 'AssistantPart', 'TurnGap', 'AssistantPart', 'Thinking']);
  assert.equal(turnOf(view.rows, finishedTurn).running, false, 'the finished turn is not running again');
  assert.notEqual(view.rows.at(-1).turnKey, finishedTurn);
  assert.ok(view.card(), 'its card stays mounted');
  assert.equal(view.reads, 1, 'and is not read again');
});

/** The finished turn as a wake leaves it: its rows, not running, with its card mounted and read once. */
function assertFinishedTurnStands(view, finishedTurn, when) {
  assert.equal(turnOf(view.rows, finishedTurn).running, false, `${when}: the finished turn is not running again`);
  const first = view.rows.findIndex((row) => row.turnKey !== finishedTurn);
  assert.equal(view.rows[first]._tag, 'TurnGap', `${when}: a gap follows the finished turn`);
  assert.ok(
    view.rows.slice(first).every((row) => row.turnKey !== finishedTurn),
    `${when}: nothing after it takes its key`
  );
  assert.ok(view.card(), `${when}: its card stays mounted`);
  assert.equal(view.reads, 1, `${when}: and is not read again`);
}

test('a wake with no prompt keeps the finished turn’s card once its tools and replies settle', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  const finishedTurn = view.rows.find((row) => row._tag === 'AssistantPart').turnKey;
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  await view.render({
    items: [prompt, reply, done],
    busy: true,
    liveItem: { ...wakeReply, streaming: true },
    activityAt: 9_000,
  });
  // Its first reply settles after the finished turn's end, and the wake goes on.
  await view.render({ items: [prompt, reply, done, wakeReply], busy: true, activityAt: 9_000 });
  assertFinishedTurnStands(view, finishedTurn, 'a reply settled');
  const next = { kind: 'assistant', id: 'wake-next', text: 'Checking the result.', streaming: true, at: 9_400 };
  await view.render({ items: [prompt, reply, done, wakeReply], busy: true, liveItem: next, activityAt: 9_000 });
  assertFinishedTurnStands(view, finishedTurn, 'another reply arriving');
  assert.equal(view.rows.at(-1)._tag, 'Thinking');
});

test('a wake that ends on a checkpoint of its own leaves the finished turn’s card standing; its own waits for idle', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  const wakeDone = { ...done, id: 'wake-done', checkpointId: 'cp-wake', finalAssistantId: 'wake-reply', at: 9_500 };
  const settled = [prompt, reply, done, wakeReply];
  await view.render({ items: settled, busy: true, activityAt: 9_000 });
  // The wake's end is written while the session still reports it busy: both ends stand after the last prompt.
  await view.render({ items: [...settled, wakeDone], busy: true, activityAt: 9_000 });
  assert.equal(view.cards(), 1, 'the finished turn’s card stays through the wake’s end');
  assert.deepEqual(view.read, ['cp'], 'and the wake’s own record is not read while it winds down');
  await view.render({ items: [...settled, wakeDone], busy: false });
  assert.deepEqual(view.read, ['cp', 'cp-wake'], 'one read of the wake’s record, at idle');
  assert.equal(view.cards(), 2);
});

test('a wake that closes the same checkpoint again keeps the card standing through its end', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  assert.equal(view.cards(), 1);
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  const wakeDone = { ...done, id: 'wake-done', finalAssistantId: 'wake-reply', at: 9_500 };
  const settled = [prompt, reply, done, wakeReply];
  await view.render({ items: settled, busy: true, activityAt: 9_000 });
  assert.equal(view.cards(), 1);
  // The wake's end names the same checkpoint and the session still reports it busy: the card moves to that end, shown
  // from the reply held of the earlier end while the newer one is read.
  await act(async () =>
    view.root.render(h(view.Pane, { items: [...settled, wakeDone], busy: true, activityAt: 9_000 }))
  );
  assert.equal(view.cards(), 1, 'never hidden between the two ends, nor while it is read again');
  await settle();
  assert.equal(view.cards(), 1);
  assert.equal(view.reads, 2, 'the newer end is read');
  await view.render({ items: [...settled, wakeDone], busy: false });
  assert.equal(view.cards(), 1);
});

test('a wake’s end written before its reply settles leaves the card on the end it stood on', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  assert.equal(view.cards(), 1);
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  const arriving = { ...wakeReply, streaming: true };
  // The same checkpoint is closed again by an end that names the reply still arriving.
  const wakeDone = { ...done, id: 'wake-done', finalAssistantId: 'wake-reply', at: 9_500 };
  await view.render({ items: [prompt, reply, done], busy: true, liveItem: arriving, activityAt: 9_000 });
  const before = view.tags();
  assert.equal(view.cards(), 1);
  await act(async () =>
    view.root.render(
      h(view.Pane, { items: [prompt, reply, done, wakeDone], busy: true, liveItem: arriving, activityAt: 9_000 })
    )
  );
  assert.equal(view.cards(), 1, 'the end is not shown before its reply: the card has not moved');
  assert.deepEqual(view.tags(), before);
  await act(async () =>
    view.root.render(h(view.Pane, { items: [prompt, reply, done, wakeDone, wakeReply], busy: true }))
  );
  assert.equal(view.cards(), 1, 'moved with the reply, shown from the reply held');
  await view.render({ items: [prompt, reply, done, wakeDone, wakeReply], busy: false });
  assert.equal(view.cards(), 1);
});

test('an end that names a reply still arriving closes no earlier reply of its turn', async (t) => {
  const view = await mountPane(t);
  const first = { kind: 'assistant', id: 'first', text: 'I will check.', at: 1_500 };
  const tool = {
    kind: 'tool',
    id: 'tool',
    name: 'read',
    args: { file_path: 'a.ts' },
    result: 'ok',
    completedAt: 2_000,
  };
  const arriving = { ...reply, streaming: true };
  await view.render({ items: [prompt, first, tool], busy: true, liveItem: arriving, activityAt: 1_000 });
  const footers = () => view.rows.filter((row) => row.completion).map((row) => row.item.id);
  assert.deepEqual(footers(), []);
  // The end names the final reply, which has not settled: the first reply does not take its footer.
  await view.render({ items: [prompt, first, tool, done], busy: true, liveItem: arriving, activityAt: 1_000 });
  assert.deepEqual(footers(), [], 'no footer above the tool');
  assert.equal(view.rows.at(-1)._tag, 'Thinking');
  await view.render({ items: [prompt, first, tool, done, reply], busy: false });
  assert.deepEqual(footers(), ['reply']);
});

test('a hidden wake keeps its gap when its end is written before its reply settles', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  const finishedTurn = view.rows.find((row) => row._tag === 'AssistantPart').turnKey;
  const kickoff = { kind: 'user', id: 'wake-kickoff', text: 'A task finished.', hidden: true, at: 9_000 };
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  const arriving = { ...wakeReply, streaming: true };
  const wakeDone = { ...done, id: 'wake-done', checkpointId: 'cp-wake', finalAssistantId: 'wake-reply', at: 9_500 };
  const base = [prompt, reply, done, kickoff];
  await view.render({ items: base, busy: true, liveItem: arriving, activityAt: 9_000 });
  const before = view.tags();
  assertFinishedTurnStands(view, finishedTurn, 'the wake reply arriving');
  await view.render({ items: [...base, wakeDone], busy: true, liveItem: arriving, activityAt: 9_000 });
  assert.deepEqual(view.tags(), before, 'the end changes no row while its reply still arrives');
  assertFinishedTurnStands(view, finishedTurn, 'the wake’s end written first');
});

test('an end that names a reply still arriving draws no row of its own', async (t) => {
  const view = await mountPane(t);
  const arriving = { ...reply, streaming: true };
  await view.render({ items: [prompt], busy: true, liveItem: arriving, activityAt: 1_000 });
  const before = view.tags();
  await view.render({ items: [prompt, done], busy: true, liveItem: arriving, activityAt: 1_000 });
  assert.deepEqual(view.tags(), before, 'no completion line above the reply it will close');
  // Settled, the reply carries the end as its footer.
  await view.render({ items: [prompt, done, reply], busy: false });
  assert.deepEqual(view.tags(), ['UserMessage', 'AssistantPart']);
  assert.ok(view.rows[1].completion);
});

test('a wake whose kickoff is a hidden prompt opens its own turn: the finished turn is not running again', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  const finishedTurn = view.rows.find((row) => row._tag === 'AssistantPart').turnKey;
  // The kickoff places no row: the band under the finished turn is the wake's.
  const kickoff = { kind: 'user', id: 'wake-kickoff', text: 'A task finished.', hidden: true, at: 9_000 };
  await view.render({ items: [prompt, reply, done, kickoff], busy: true, activityAt: 9_000 });
  assert.equal(view.rows.at(-1)._tag, 'Thinking');
  assertFinishedTurnStands(view, finishedTurn, 'the kickoff alone');
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  await view.render({ items: [prompt, reply, done, kickoff, wakeReply], busy: true, activityAt: 9_000 });
  assertFinishedTurnStands(view, finishedTurn, 'its first reply settled');
  assert.equal(view.rows.at(-1).turnKey, view.rows.find((row) => row.item === wakeReply).turnKey);
});

test('a pane mounted in the middle of a wake shows the finished turn’s card', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  // Nothing was seen before: the rows after the end say it is passed.
  await view.render({ items: [prompt, reply, done, wakeReply], busy: true, activityAt: 9_000 });
  assert.ok(view.card());
  assert.deepEqual(view.read, ['cp']);
});

test('a wake that has settled a row is the turn seen running: its end may open its previews', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  const wakeReply = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', at: 9_100 };
  await view.render({ items: [prompt, reply, done, wakeReply], busy: true, activityAt: 9_000 });
  // Its end and idle can arrive in one frame: no later busy frame would note it.
  claimTurnPreviewEnd('s1', 'segment:wake-reply', 'cp-wake');
  assert.equal(turnPreviewOpenPending('s1', 'cp-wake'), true);
});

test('a reply that settles after the end that names it stays in its turn, under its footer', async (t) => {
  const view = await mountPane(t);
  const shape = () => view.rows.map((row) => [row._tag, row.turnKey, Boolean(row.completion)]);
  // The turn with its end settled before its reply, the session still winding down.
  await view.render({ items: [prompt, done, reply], busy: true, activityAt: 1_000 });
  const late = shape();
  assert.deepEqual(
    view.tags(),
    ['UserMessage', 'AssistantPart'],
    'no gap above the reply and no band under its footer'
  );
  assert.equal(late[1][2], true, 'the reply carries the end as its footer');
  assert.equal(view.reads, 0, 'the card still waits for idle');
  // The same turn in order reads the same.
  await view.render({ items: [prompt, reply, done], busy: true, activityAt: 1_000 });
  assert.deepEqual(shape(), late);
});

test('a message sent during a streaming wake leaves its reply out of the finished turn', async (t) => {
  const view = await mountPane(t);
  view.sealed = true;
  await view.render({ items: [prompt, reply, done], busy: false });
  const finishedTurn = view.rows.find((row) => row._tag === 'AssistantPart').turnKey;
  const arriving = { kind: 'assistant', id: 'wake-reply', text: 'The worker is done.', streaming: true, at: 9_100 };
  const wake = { items: [prompt, reply, done], busy: true, liveItem: arriving, activityAt: 9_000 };
  await view.render(wake);
  const liveBefore = view.rows.find((row) => row.live);
  await view.render({ ...wake, steerItems: [{ kind: 'user', id: 'steer', text: 'Also check the tests', at: 9_200 }] });
  assertFinishedTurnStands(view, finishedTurn, 'a steer pending');
  const live = view.rows.findIndex((row) => row.live);
  assert.equal(view.rows[live - 1]._tag, 'TurnGap', 'the gap above the reply stands');
  assert.equal(view.rows[live].turnKey, liveBefore.turnKey, 'the reply keeps its turn');
  assert.deepEqual(
    view.rows
      .slice(live + 1)
      .map((row) => row._tag)
      .filter((tag) => tag !== 'TurnGap'),
    ['UserMessage', 'Thinking']
  );
});

test('frame-by-frame mid-turn progression shows zero visualize or diff cards until final paced reply drains, then one stable owner', async (t) => {
  const view = await mountTranscriptPane(t);
  // JSDOM defaults `document.hidden` to true, which disables paced text drain.
  Object.defineProperty(view.document, 'hidden', { configurable: true, value: false });
  setVisualizePanelOnScreen('s1', true);
  resyncVisualizeStates([
    {
      sessionId: 's1',
      active: 'v1',
      tabs: [{ id: 'v1', label: 'Preview', revision: 1, panes: [{ target: 'site/a.html' }], versions: [{ n: 1 }] }],
    },
  ]);
  t.after(() => {
    setVisualizePanelOnScreen('s1', false);
    resyncVisualizeStates([]);
  });

  const p1 = { kind: 'user', id: 'u1', checkpointId: 'cp1', text: 'Build page', at: 1_000 };
  const visOpen = {
    kind: 'tool',
    id: 'vis1',
    name: 'visualize',
    args: { action: 'open', input: { targets: ['site/a.html'], label: 'Preview' } },
    result: 'Showing site/a.html (html) in the side panel as tab v1.',
    status: 'done',
    startedAt: 1_100,
    completedAt: 1_200,
  };
  const midReply = { kind: 'assistant', id: 'a1', attemptId: 'att-mid', text: 'Opening preview first.', at: 1_300 };
  const midDone = {
    kind: 'turndone',
    id: 'd1',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att-mid',
    checkpointId: 'cp1',
    finalAssistantId: 'a1',
    at: 1_350,
  };
  const editTool = {
    kind: 'tool',
    id: 'ed1',
    name: 'edit',
    args: { file_path: 'src/a.ts' },
    result: 'Updated src/a.ts',
    status: 'done',
    startedAt: 1_400,
    completedAt: 1_500,
  };
  // Start short (enters paced reveal with zero timer backlog), then grow by ~500 chars
  // (> REVEAL_SETTLE_SNAP_MAX_CHARS=220, <= REVEAL_REJOIN_CHARS=600) so settling deterministically drains.
  const initialLiveText = 'Opening update. ';
  const pacedFinalText =
    initialLiveText +
    Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1} explains the final update clearly.`).join(' ');
  const finalLiveStart = {
    kind: 'assistant',
    id: 'a2',
    attemptId: 'att-mid',
    text: initialLiveText,
    streaming: true,
    at: 1_600,
  };
  const finalLiveFull = {
    kind: 'assistant',
    id: 'a2',
    attemptId: 'att-mid',
    text: pacedFinalText,
    streaming: true,
    at: 1_650,
  };
  const finalSettled = { kind: 'assistant', id: 'a2', attemptId: 'att-mid', text: pacedFinalText, at: 1_700 };
  const finalDone = {
    kind: 'turndone',
    id: 'd2',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att-mid',
    checkpointId: 'cp1',
    finalAssistantId: 'a2',
    at: 1_750,
  };

  // Frame 1: tool open finished, turn still running (no turndone yet)
  await view.render({ items: [p1, visOpen], busy: true, activityAt: 1_000 });
  assert.equal(view.visualizeCards(), 0, 'frame 1: zero visualize cards on open tool tail');
  assert.equal(view.cards(), 0, 'frame 1: zero diff cards on open tool tail');

  // Frame 2: intermediate end while session still busy
  await view.render({ items: [p1, visOpen, midReply, midDone], busy: true, activityAt: 1_000 });
  assert.equal(view.visualizeCards(), 0, 'frame 2: zero visualize cards at intermediate end');
  assert.equal(view.cards(), 0, 'frame 2: zero diff cards at intermediate end');

  // Frame 3: further tool + live streaming final reply (enters paced mode then buffers backlog)
  await view.render({
    items: [p1, visOpen, midReply, midDone, editTool],
    busy: true,
    liveItem: finalLiveStart,
    activityAt: 1_000,
  });
  view.renderSync({
    items: [p1, visOpen, midReply, midDone, editTool],
    busy: true,
    liveItem: finalLiveFull,
    activityAt: 1_000,
  });
  assert.equal(view.visualizeCards(), 0, 'frame 3: zero visualize cards during further tool + streaming reply');
  assert.equal(view.cards(), 0, 'frame 3: zero diff cards during further tool + streaming reply');

  // Frame 4: final end arrives and busy flips false, while closing reply is still visually draining paced text
  view.renderSync({ items: [p1, visOpen, midReply, midDone, editTool, finalSettled, finalDone], busy: false });
  assert.equal(isRowVisuallyStreaming('s1:a2'), true, 'frame 4: closing reply is still draining paced text');
  assert.equal(view.visualizeCards(), 0, 'frame 4: zero visualize cards while closing reply still drains');
  assert.equal(view.cards(), 0, 'frame 4: zero diff cards while closing reply still drains');

  // Wait for paced text drain timers to finish naturally
  for (
    let guard = 0;
    guard < 60 && (isRowVisuallyStreaming('s1:a2') || view.visualizeCards() === 0 || view.cards() === 0);
    guard += 1
  ) {
    await settle(25);
  }

  // Frame 5: exactly one visualize card and one diff card attached to the final reply row
  assert.equal(view.visualizeCards(), 1, 'final frame: exactly one visualize card');
  assert.equal(view.cards(), 1, 'final frame: exactly one diff card');
  const finalRow = view.document.querySelector('[data-row-key="s1:a2"]');
  assert.ok(finalRow?.querySelector('.transcript-visualize-turn'), 'visualize card owned by final reply');
  assert.ok(finalRow?.querySelector('.turn-changes-card'), 'diff card owned by final reply');
});

test('synchronous preview-path exclusion prevents first-render TurnChangesCard flash for auto-previewed files', async (t) => {
  const view = await mountTranscriptPane(t);
  view.holdReads = true;
  view.files = [{ path: 'report.html', status: 'A', additions: 10, deletions: 0, state: 'applied', revertable: true }];
  setVisualizePanelOnScreen('s1', true);
  resyncVisualizeStates([{ sessionId: 's1', active: '', tabs: [] }]);
  t.after(() => {
    setVisualizePanelOnScreen('s1', false);
    resyncVisualizeStates([]);
  });

  const p1 = { kind: 'user', id: 'u-prev', checkpointId: 'cp-prev', text: 'Build report', at: 1_000 };
  const writeTool = {
    kind: 'tool',
    id: 'w1',
    name: 'write',
    args: { file_path: 'C:/Project/app/report.html', content: '<h1>Report</h1>\n<p>hello</p>\n' },
    result: 'Wrote report.html',
    status: 'done',
    startedAt: 1_100,
    completedAt: 1_200,
  };
  const r1 = { kind: 'assistant', id: 'a-prev', text: 'Saved [report.html](report.html).', at: 1_300 };
  const d1 = {
    kind: 'turndone',
    id: 'd-prev',
    status: 'done',
    verb: 'Completed',
    checkpointId: 'cp-prev',
    finalAssistantId: 'a-prev',
    at: 1_350,
  };

  // Synchronous Render 1 while getTurnChanges is still pending (uses recordedTurnChanges):
  // report.html is excluded synchronously so TurnChangesCard never flashes.
  view.renderSync({ items: [p1, writeTool, r1, d1], busy: false });
  assert.equal(view.cards(), 0, 'render 1 (pending read / recordedTurnChanges): zero diff-card flash');

  // Once getTurnChanges resolves: still zero diff card, and the automatic preview card renders with Undo.
  await view.releaseReads();
  assert.equal(view.cards(), 0, 'after read resolves: still zero diff card');
  assert.equal(view.visualizeCards(), 1, 'after read resolves: automatic preview card stands in');
});

test('turndone diff and visualize cards render immediately even while background agents or shell jobs are active', async (t) => {
  const view = await mountTranscriptPane(t);
  view.files = [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1, state: 'applied', revertable: true }];
  setVisualizePanelOnScreen('s1', true);
  resyncVisualizeStates([
    {
      sessionId: 's1',
      active: 'v1',
      tabs: [{ id: 'v1', label: 'Preview', revision: 1, panes: [{ target: 'site/a.html' }], versions: [{ n: 1 }] }],
    },
  ]);
  t.after(() => {
    setVisualizePanelOnScreen('s1', false);
    resyncVisualizeStates([]);
  });

  const p1 = { kind: 'user', id: 'u-bg', checkpointId: 'cp-bg', text: 'Launch worker and edit file', at: 1_000 };
  const visOpen = {
    kind: 'tool',
    id: 'vis-bg',
    name: 'visualize',
    args: { action: 'open', input: { targets: ['site/a.html'], label: 'Preview' } },
    result: 'Showing site/a.html (html) in the side panel as tab v1.',
    status: 'done',
    startedAt: 1_100,
    completedAt: 1_200,
  };
  const a1 = { kind: 'assistant', id: 'a-bg', text: 'Worker launched.', at: 1_300 };
  const d1 = {
    kind: 'turndone',
    id: 'd-bg',
    status: 'done',
    verb: 'Completed',
    checkpointId: 'cp-bg',
    finalAssistantId: 'a-bg',
    at: 1_350,
  };

  // Background agent active (agent > 0)
  await view.render({
    items: [p1, visOpen, a1, d1],
    busy: false,
    agentWorkers: [{ id: 'worker-1', status: 'running', role: 'worker' }],
  });
  assert.equal(view.cards(), 1, 'diff card renders immediately with active background agent');
  assert.equal(view.visualizeCards(), 1, 'visualize card renders immediately with active background agent');
  assert.ok(view.document.querySelector('[data-row-key="s1:a-bg"] .turn-changes-card'), 'diff card pinned to a-bg');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a-bg"] .transcript-visualize-turn'),
    'visualize card pinned to a-bg'
  );
  assert.ok(view.text().includes('Waiting on 1 agents'), 'completion status still reports active background agent');

  // Background shell job active (shell > 0)
  await view.render({
    items: [p1, visOpen, a1, d1],
    busy: false,
    shellJobs: { count: 2, jobs: [] },
  });
  assert.equal(view.cards(), 1, 'diff card stays pinned with active background shell jobs');
  assert.equal(view.visualizeCards(), 1, 'visualize card stays pinned with active background shell jobs');
  assert.ok(view.text().includes('Waiting on 2 shell jobs'), 'completion status still reports active shell jobs');
});

test('two consecutive turndones with distinct checkpointIds keep separate fixed cards while a subsequent wake streams and completes', async (t) => {
  const view = await mountTranscriptPane(t);
  view.files = (cp) => [
    {
      path: cp === 'cp1' ? 'src/first.ts' : 'src/second.ts',
      status: 'M',
      additions: 4,
      deletions: 1,
      state: 'applied',
      revertable: true,
    },
  ];

  // Turn 1 ends while a background agent is still running -> card pins immediately to a1.
  const p1 = { kind: 'user', id: 'u1', checkpointId: 'cp1', text: 'Start task', at: 1_000 };
  const a1 = { kind: 'assistant', id: 'a1', text: 'First step done.', at: 1_200 };
  const d1 = {
    kind: 'turndone',
    id: 'd1',
    status: 'done',
    verb: 'Completed',
    checkpointId: 'cp1',
    finalAssistantId: 'a1',
    at: 1_250,
  };
  await view.render({
    items: [p1, a1, d1],
    busy: false,
    agentWorkers: [{ id: 'w1', status: 'running', role: 'worker' }],
  });
  assert.equal(view.cards(), 1, 'turn 1 card renders immediately despite running background agent');
  assert.ok(view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card'), 'card pinned to a1');

  // Wake Turn 2 starts and streams with no visible user prompt in between -> a1's card stays visible and untouched.
  const wakeKickoff = { kind: 'user', id: 'w-kick', text: 'Worker finished', hidden: true, at: 2_000 };
  const wakeTool = {
    kind: 'tool',
    id: 't2',
    name: 'edit',
    args: { file_path: 'src/second.ts' },
    result: 'ok',
    status: 'done',
    at: 2_100,
  };
  const wakeLive = { kind: 'assistant', id: 'a2', text: 'Applying wake result...', streaming: true, at: 2_200 };
  await view.render({
    items: [p1, a1, d1, wakeKickoff, wakeTool],
    busy: true,
    liveItem: wakeLive,
    activityAt: 2_000,
  });
  assert.equal(view.cards(), 1, 'turn 1 card remains visible while wake turn streams');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card'),
    'a1 keeps its card while wake streams'
  );
  assert.deepEqual(view.read, ['cp1'], 'only cp1 read so far');

  // Wake Turn 2 writes its own turndone with distinct checkpointId cp2 while busy is still winding down ->
  // a1 keeps its card and a2 waits until idle.
  const a2 = { kind: 'assistant', id: 'a2', text: 'Wake finished.', at: 2_300 };
  const d2 = {
    kind: 'turndone',
    id: 'd2',
    status: 'done',
    verb: 'Completed',
    checkpointId: 'cp2',
    finalAssistantId: 'a2',
    at: 2_350,
  };
  await view.render({
    items: [p1, a1, d1, wakeKickoff, wakeTool, a2, d2],
    busy: true,
    activityAt: 2_000,
  });
  assert.equal(view.cards(), 1, 'a1 card stays visible while a2 winds down');
  assert.ok(view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card'), 'a1 card still pinned');
  assert.equal(
    view.document.querySelector('[data-row-key="s1:a2"] .turn-changes-card'),
    null,
    'a2 card waits for idle'
  );

  // Wake Turn 2 finishes idle -> BOTH a1 (cp1) and a2 (cp2) have their own separate pinned cards.
  await view.render({
    items: [p1, a1, d1, wakeKickoff, wakeTool, a2, d2],
    busy: false,
  });
  assert.equal(view.cards(), 2, 'each distinct checkpointId turndone keeps its own card');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card')?.textContent?.includes('src/first.ts'),
    'a1 keeps cp1 card'
  );
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a2"] .turn-changes-card')?.textContent?.includes('src/second.ts'),
    'a2 gets its own cp2 card'
  );
  assert.deepEqual(view.read, ['cp1', 'cp2']);

  // A subsequent wake turndone without a checkpointId does not steal an earlier turn's card.
  const a3 = { kind: 'assistant', id: 'a3', text: 'Follow-up note.', at: 3_000 };
  const d3 = { kind: 'turndone', id: 'd3', status: 'done', verb: 'Completed', finalAssistantId: 'a3', at: 3_050 };
  await view.render({
    items: [p1, a1, d1, wakeKickoff, wakeTool, a2, d2, a3, d3],
    busy: false,
  });
  assert.equal(view.cards(), 2, 'checkpointless wake turndone steals neither cp1 nor cp2');
  assert.ok(view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card'), 'a1 still owns cp1');
  assert.ok(view.document.querySelector('[data-row-key="s1:a2"] .turn-changes-card'), 'a2 still owns cp2');
  assert.equal(view.document.querySelector('[data-row-key="s1:a3"] .turn-changes-card'), null, 'a3 has no diff card');
});

test('two distinct wake attempts (cp1, cp2) arriving without an intervening idle snapshot keep cp1 boundary and card intact', async (t) => {
  const view = await mountTranscriptPane(t);
  view.files = (cp) => [
    {
      path: cp === 'cp1' ? 'src/first.ts' : 'src/second.ts',
      status: 'M',
      additions: 2,
      deletions: 1,
      state: 'applied',
      revertable: true,
    },
  ];

  const p1 = { kind: 'user', id: 'u1', checkpointId: 'cp1', text: 'Run task', at: 1_000 };
  const a1 = { kind: 'assistant', id: 'a1', attemptId: 'att1', text: 'First attempt done.', at: 1_200 };
  const d1 = {
    kind: 'turndone',
    id: 'd1',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att1',
    checkpointId: 'cp1',
    finalAssistantId: 'a1',
    at: 1_250,
  };
  const t2 = {
    kind: 'tool',
    id: 't2',
    name: 'edit',
    args: { file_path: 'src/second.ts' },
    result: 'ok',
    status: 'done',
    at: 1_400,
  };
  const a2 = { kind: 'assistant', id: 'a2', attemptId: 'att2', text: 'Second attempt running.', at: 1_500 };
  const d2 = {
    kind: 'turndone',
    id: 'd2',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att2',
    checkpointId: 'cp2',
    finalAssistantId: 'a2',
    at: 1_550,
  };

  // Frame 1: attempt 1 closes while session is still busy (no idle frame before attempt 2 starts).
  await view.render({ items: [p1, a1, d1], busy: true, activityAt: 1_000 });
  assert.equal(view.cards(), 0, 'frame 1: d1 card waits while attempt 1 winds down');

  // Frame 2: attempt 2 runs with a distinct attemptId (still busy, no intervening idle snapshot).
  // d1 must NOT be erased by passedEnds, and cp1's card must be visible while attempt 2 runs.
  await view.render({ items: [p1, a1, d1, t2, a2], busy: true, activityAt: 1_000 });
  assert.ok(
    view.rows.find((row) => row.key === 's1:a1')?.completion,
    'frame 2: d1 completion stays intact on a1 when distinct attempt 2 arrives'
  );
  assert.equal(view.cards(), 1, 'frame 2: cp1 card reveals once distinct attempt 2 is underway');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card')?.textContent?.includes('src/first.ts'),
    'frame 2: a1 owns cp1 card'
  );

  // Frame 3: attempt 2 closes with cp2 while still busy -> cp1 stays visible, cp2 waits for idle.
  await view.render({ items: [p1, a1, d1, t2, a2, d2], busy: true, activityAt: 1_000 });
  assert.equal(view.cards(), 1, 'frame 3: cp1 stays visible while cp2 winds down');
  assert.ok(view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card'), 'frame 3: a1 still owns cp1');
  assert.equal(
    view.document.querySelector('[data-row-key="s1:a2"] .turn-changes-card'),
    null,
    'frame 3: cp2 waits for idle'
  );

  // Frame 4: idle -> both cp1 and cp2 render on their respective rows.
  await view.render({ items: [p1, a1, d1, t2, a2, d2], busy: false });
  assert.equal(view.cards(), 2, 'frame 4: both cp1 and cp2 cards are pinned');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a1"] .turn-changes-card')?.textContent?.includes('src/first.ts'),
    'frame 4: a1 keeps cp1 card'
  );
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a2"] .turn-changes-card')?.textContent?.includes('src/second.ts'),
    'frame 4: a2 keeps cp2 card'
  );
});

test('tool-ending turn [assistant, tool, turndone] holds diff card until its assistant row finishes visual streaming', async (t) => {
  const view = await mountTranscriptPane(t);
  // JSDOM defaults `document.hidden` to true, which disables paced text drain.
  Object.defineProperty(view.document, 'hidden', { configurable: true, value: false });

  const p1 = { kind: 'user', id: 'u-tool-end', checkpointId: 'cp-tool-end', text: 'Edit file', at: 1_000 };
  const initialLiveText = 'Running edit now. ';
  const pacedText =
    initialLiveText +
    Array.from({ length: 10 }, (_, i) => `Detail sentence ${i + 1} explains the upcoming file edit clearly.`).join(' ');
  const a1LiveStart = { kind: 'assistant', id: 'a-tool-end', text: initialLiveText, streaming: true, at: 1_100 };
  const a1LiveFull = { kind: 'assistant', id: 'a-tool-end', text: pacedText, streaming: true, at: 1_150 };
  const a1Settled = { kind: 'assistant', id: 'a-tool-end', text: pacedText, at: 1_200 };
  const editTool = {
    kind: 'tool',
    id: 'ed-tool-end',
    name: 'edit',
    args: { file_path: 'src/a.ts' },
    result: 'Updated src/a.ts',
    status: 'done',
    startedAt: 1_250,
    completedAt: 1_300,
  };
  const d1 = {
    kind: 'turndone',
    id: 'd-tool-end',
    status: 'done',
    verb: 'Completed',
    checkpointId: 'cp-tool-end',
    at: 1_350,
  };

  // Start paced reveal on a1 and buffer enough backlog that settling a1 enters draining mode.
  await view.render({ items: [p1], busy: true, liveItem: a1LiveStart, activityAt: 1_000 });
  view.renderSync({ items: [p1], busy: true, liveItem: a1LiveFull, activityAt: 1_000 });
  assert.equal(view.cards(), 0, 'no diff card while streaming');

  // Settle [p1, a1Settled, editTool, d1] (standalone turndone row after tool) and flip busy false
  // while a1 is still visually draining paced text.
  view.renderSync({ items: [p1, a1Settled, editTool, d1], busy: false });
  assert.equal(view.rows.at(-2)?._tag, 'AssistantPart', 'standalone turndone sits before Thinking band while draining');
  assert.equal(view.rows.at(-2)?.item?.kind, 'turndone');
  assert.equal(isRowVisuallyStreaming('s1:a-tool-end'), true, 'assistant row is still draining paced text');
  assert.equal(view.cards(), 0, 'diff card on standalone turndone waits while assistant row still drains');

  for (let guard = 0; guard < 60 && (isRowVisuallyStreaming('s1:a-tool-end') || view.cards() === 0); guard += 1) {
    await settle(25);
  }
  assert.equal(isRowVisuallyStreaming('s1:a-tool-end'), false, 'assistant row finished draining');
  assert.equal(view.cards(), 1, 'diff card reveals once assistant row finishes draining');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:d-tool-end"] .turn-changes-card'),
    'diff card attaches to standalone turndone row'
  );
});

test('revealing a checkpointless visualize card preserves the exact .transcript-live-part DOM node', async (t) => {
  const view = await mountTranscriptPane(t);
  setVisualizePanelOnScreen('s1', true);
  resyncVisualizeStates([
    {
      sessionId: 's1',
      active: 'v1',
      tabs: [{ id: 'v1', label: 'Preview', revision: 1, panes: [{ target: 'site/a.html' }], versions: [{ n: 1 }] }],
    },
  ]);
  t.after(() => {
    setVisualizePanelOnScreen('s1', false);
    resyncVisualizeStates([]);
  });

  // Checkpointless segment (no user prompt, no checkpointId on turndone -> row.turnChanges is undefined).
  const visOpen = {
    kind: 'tool',
    id: 'vis-nocp',
    name: 'visualize',
    args: { action: 'open', input: { targets: ['site/a.html'], label: 'Preview' } },
    result: 'Showing site/a.html (html) in the side panel as tab v1.',
    status: 'done',
    startedAt: 1_100,
    completedAt: 1_200,
  };
  const a1Live = { kind: 'assistant', id: 'a-nocp', text: 'Preview is ready.', streaming: true, at: 1_300 };
  const a1Settled = { kind: 'assistant', id: 'a-nocp', text: 'Preview is ready.', at: 1_350 };
  const d1 = {
    kind: 'turndone',
    id: 'd-nocp',
    status: 'done',
    verb: 'Completed',
    finalAssistantId: 'a-nocp',
    at: 1_400,
  };

  await view.render({ items: [visOpen], busy: true, liveItem: a1Live, activityAt: 1_000 });
  assert.equal(view.visualizeCards(), 0, 'visualize card hidden while streaming');
  const livePartBefore = view.document.querySelector('[data-row-key="s1:a-nocp"] .transcript-live-part');
  assert.ok(livePartBefore, 'captured .transcript-live-part before reveal');

  await view.render({ items: [visOpen, a1Settled, d1], busy: false });
  const settledRow = view.rows.find((row) => row.key === 's1:a-nocp');
  assert.equal(settledRow?.turnChanges, undefined, 'row has no turnChanges (checkpointless)');
  assert.equal(view.visualizeCards(), 1, 'checkpointless visualize card revealed');
  const livePartAfter = view.document.querySelector('[data-row-key="s1:a-nocp"] .transcript-live-part');
  assert.equal(livePartAfter, livePartBefore, '.transcript-live-part DOM node is preserved without remount');
});

test('rejected getTurnChanges for a linked auto-preview file still renders the retryable error card and recovers on retry', async (t) => {
  const view = await mountTranscriptPane(t);
  view.holdReads = true;
  view.failReads = new Error('disk offline');
  view.files = [{ path: 'report.html', status: 'A', additions: 10, deletions: 0, state: 'applied', revertable: true }];
  setVisualizePanelOnScreen('s1', true);
  resyncVisualizeStates([{ sessionId: 's1', active: '', tabs: [] }]);
  t.after(() => {
    setVisualizePanelOnScreen('s1', false);
    resyncVisualizeStates([]);
  });

  const p1 = { kind: 'user', id: 'u-fail', checkpointId: 'cp-fail', text: 'Build report', at: 1_000 };
  const writeTool = {
    kind: 'tool',
    id: 'w-fail',
    name: 'write',
    args: { file_path: 'C:/Project/app/report.html', content: '<h1>Report</h1>\n<p>hello</p>\n' },
    result: 'Wrote report.html',
    status: 'done',
    startedAt: 1_100,
    completedAt: 1_200,
  };
  const r1 = { kind: 'assistant', id: 'a-fail', text: 'Saved [report.html](report.html).', at: 1_300 };
  const d1 = {
    kind: 'turndone',
    id: 'd-fail',
    status: 'done',
    verb: 'Completed',
    checkpointId: 'cp-fail',
    finalAssistantId: 'a-fail',
    at: 1_350,
  };

  // While read is pending, synchronous preview exclusion still prevents a diff-card flash.
  view.renderSync({ items: [p1, writeTool, r1, d1], busy: false });
  assert.equal(view.cards(), 0, 'pending read: zero diff-card flash');

  // Once getTurnChanges rejects, auto-preview cannot render, so the fallback TurnChangesCard
  // must stay visible with data-read="failed" so the user sees the artifact and can retry.
  await view.releaseReads();
  assert.equal(view.visualizeCards(), 0, 'failed read: no auto-preview card');
  assert.equal(view.cards(), 1, 'failed read: retryable TurnChangesCard renders');
  const failedCard = view.card();
  assert.equal(failedCard?.dataset.read, 'failed', 'card reports failed read state');
  assert.ok(failedCard?.textContent?.includes('report.html'), 'failed card names report.html');

  // Clicking the failed card retries getTurnChanges and recovers into the auto-preview card.
  view.failReads = null;
  view.holdReads = false;
  await act(async () => {
    failedCard.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await view.settleReads();
  assert.equal(view.cards(), 0, 'after retry succeeds: diff card yields back to auto-preview');
  assert.equal(view.visualizeCards(), 1, 'after retry succeeds: auto-preview card renders');
});

test('late-settled named reply after d1 does not erase d1 or cp1 card while a2 (cp2) streams', async (t) => {
  const view = await mountTranscriptPane(t);
  view.files = (cp) =>
    cp === 'cp-late-1'
      ? [{ path: 'src/first.ts', status: 'M', additions: 3, deletions: 1, state: 'applied', revertable: true }]
      : [{ path: 'src/second.ts', status: 'A', additions: 7, deletions: 0, state: 'applied', revertable: true }];

  const p1 = { kind: 'user', id: 'u-late', checkpointId: 'cp-late-1', text: 'Run task', at: 1_000 };
  const d1 = {
    kind: 'turndone',
    id: 'd-late-1',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att-late-1',
    turnId: 'turn-late-1',
    checkpointId: 'cp-late-1',
    finalAssistantId: 'a-late-1',
    at: 1_250,
  };
  const a1 = {
    kind: 'assistant',
    id: 'a-late-1',
    attemptId: 'att-late-1',
    turnId: 'turn-late-1',
    text: 'First attempt done.',
    at: 1_260,
  };
  const a2Live = {
    kind: 'assistant',
    id: 'a-late-2',
    attemptId: 'att-late-2',
    turnId: 'turn-late-2',
    text: 'Second attempt streaming...',
    streaming: true,
    at: 1_400,
  };
  const a2 = {
    kind: 'assistant',
    id: 'a-late-2',
    attemptId: 'att-late-2',
    turnId: 'turn-late-2',
    text: 'Second attempt done.',
    at: 1_450,
  };
  const d2 = {
    kind: 'turndone',
    id: 'd-late-2',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att-late-2',
    turnId: 'turn-late-2',
    checkpointId: 'cp-late-2',
    finalAssistantId: 'a-late-2',
    at: 1_500,
  };

  // Frame 1: d1 settles before its own named reply a1, while a2 streams immediately with no idle frame.
  await view.render({ items: [p1, d1, a1], busy: true, liveItem: a2Live, activityAt: 1_000 });
  assert.ok(
    view.rows.find((row) => row.key === 's1:a-late-1')?.completion,
    'frame 1: d1 stays intact when its own named reply a1 sits after d1 while a2 streams'
  );
  assert.equal(view.cards(), 1, 'frame 1: cp1 card is visible while a2 streams');
  assert.ok(
    view.document
      .querySelector('[data-row-key="s1:a-late-1"] .turn-changes-card')
      ?.textContent?.includes('src/first.ts'),
    'frame 1: a1 owns cp1 card'
  );

  // Frame 2: a2 settles while session stays busy.
  await view.render({ items: [p1, d1, a1, a2], busy: true, activityAt: 1_000 });
  assert.ok(view.rows.find((row) => row.key === 's1:a-late-1')?.completion, 'frame 2: d1 stays intact');
  assert.equal(view.cards(), 1, 'frame 2: cp1 card stays visible');
  assert.ok(
    view.document
      .querySelector('[data-row-key="s1:a-late-1"] .turn-changes-card')
      ?.textContent?.includes('src/first.ts'),
    'frame 2: a1 still owns cp1 card'
  );

  // Frame 3: d2 arrives while still busy -> cp1 stays visible, cp2 waits for idle.
  await view.render({ items: [p1, d1, a1, a2, d2], busy: true, activityAt: 1_000 });
  assert.equal(view.cards(), 1, 'frame 3: cp1 card stays visible while cp2 winds down');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a-late-1"] .turn-changes-card'),
    'frame 3: a1 still owns cp1'
  );

  // Frame 4: idle -> both cp1 and cp2 cards are pinned.
  await view.render({ items: [p1, d1, a1, a2, d2], busy: false });
  assert.equal(view.cards(), 2, 'frame 4: both cp1 and cp2 cards render at idle');
  assert.ok(
    view.document
      .querySelector('[data-row-key="s1:a-late-1"] .turn-changes-card')
      ?.textContent?.includes('src/first.ts'),
    'frame 4: a1 keeps cp1'
  );
  assert.ok(
    view.document
      .querySelector('[data-row-key="s1:a-late-2"] .turn-changes-card')
      ?.textContent?.includes('src/second.ts'),
    'frame 4: a2 keeps cp2'
  );
});

test('tool-first wake arriving one frame before its assistant row keeps d1 and cp1 card visible across all busy frames', async (t) => {
  const view = await mountTranscriptPane(t);
  view.files = (cp) =>
    cp === 'cp-tf-1'
      ? [{ path: 'src/first.ts', status: 'M', additions: 4, deletions: 1, state: 'applied', revertable: true }]
      : [{ path: 'src/second.ts', status: 'A', additions: 9, deletions: 0, state: 'applied', revertable: true }];

  const p1 = { kind: 'user', id: 'u-tf', checkpointId: 'cp-tf-1', text: 'Run task', at: 1_000 };
  const a1 = {
    kind: 'assistant',
    id: 'a-tf-1',
    attemptId: 'att-tf-1',
    turnId: 'turn-tf-1',
    text: 'First done.',
    at: 1_200,
  };
  const d1 = {
    kind: 'turndone',
    id: 'd-tf-1',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att-tf-1',
    turnId: 'turn-tf-1',
    checkpointId: 'cp-tf-1',
    finalAssistantId: 'a-tf-1',
    at: 1_250,
  };
  // Tool row carrying cp2's turnId (from protocol-client) arriving one snapshot before a2.
  const t2 = {
    kind: 'tool',
    id: 't-tf-2',
    turnId: 'turn-tf-2',
    name: 'edit',
    args: { file_path: 'src/second.ts' },
    result: 'ok',
    status: 'done',
    startedAt: 1_400,
    at: 1_400,
  };
  const a2 = {
    kind: 'assistant',
    id: 'a-tf-2',
    attemptId: 'att-tf-2',
    turnId: 'turn-tf-2',
    text: 'Wake done.',
    at: 1_500,
  };
  const d2 = {
    kind: 'turndone',
    id: 'd-tf-2',
    status: 'done',
    verb: 'Completed',
    attemptId: 'att-tf-2',
    turnId: 'turn-tf-2',
    checkpointId: 'cp-tf-2',
    finalAssistantId: 'a-tf-2',
    at: 1_550,
  };

  // Attempt 1 closes while busy (no idle snapshot before wake begins).
  await view.render({ items: [p1, a1, d1], busy: true, activityAt: 1_000 });
  assert.equal(view.cards(), 0, 'pre-wake: d1 card waits while attempt 1 winds down');

  // Busy frame 1: ONLY tool row t2 (with turn-tf-2) arrives for cp2.
  await view.render({ items: [p1, a1, d1, t2], busy: true, activityAt: 1_000 });
  assert.ok(
    view.rows.find((row) => row.key === 's1:a-tf-1')?.completion,
    'busy frame 1: wake tool carrying distinct turnId does not erase d1'
  );
  assert.equal(view.cards(), 1, 'busy frame 1: cp1 card is visible immediately when wake tool starts');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a-tf-1"] .turn-changes-card')?.textContent?.includes('src/first.ts'),
    'busy frame 1: a1 owns cp1 card'
  );

  // Busy frame 2: cp2 assistant row arrives.
  await view.render({ items: [p1, a1, d1, t2, a2], busy: true, activityAt: 1_000 });
  assert.ok(view.rows.find((row) => row.key === 's1:a-tf-1')?.completion, 'busy frame 2: d1 stays intact');
  assert.equal(view.cards(), 1, 'busy frame 2: cp1 card stays visible without flicker');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a-tf-1"] .turn-changes-card')?.textContent?.includes('src/first.ts'),
    'busy frame 2: a1 still owns cp1 card'
  );

  // Busy frame 3: cp2 turndone arrives while still busy.
  await view.render({ items: [p1, a1, d1, t2, a2, d2], busy: true, activityAt: 1_000 });
  assert.ok(view.rows.find((row) => row.key === 's1:a-tf-1')?.completion, 'busy frame 3: d1 stays intact');
  assert.equal(view.cards(), 1, 'busy frame 3: cp1 card stays visible while cp2 winds down');
  assert.equal(
    view.document.querySelector('[data-row-key="s1:a-tf-2"] .turn-changes-card'),
    null,
    'busy frame 3: cp2 waits'
  );

  // Idle: both cp1 and cp2 cards stand pinned on their respective rows.
  await view.render({ items: [p1, a1, d1, t2, a2, d2], busy: false });
  assert.equal(view.cards(), 2, 'idle: both cp1 and cp2 cards are pinned');
  assert.ok(
    view.document.querySelector('[data-row-key="s1:a-tf-1"] .turn-changes-card')?.textContent?.includes('src/first.ts'),
    'idle: a1 keeps cp1 card'
  );
  assert.ok(
    view.document
      .querySelector('[data-row-key="s1:a-tf-2"] .turn-changes-card')
      ?.textContent?.includes('src/second.ts'),
    'idle: a2 keeps cp2 card'
  );
});

test('tool-first same-attempt continuation with newer timestamp never flashes d1 or its diff card before assistant arrives', async (t) => {
  for (const mode of ['untagged', 'same-turnId']) {
    await t.test(mode, async (st) => {
      const view = await mountTranscriptPane(st);
      view.files = [{ path: 'src/a.ts', status: 'M', additions: 4, deletions: 1, state: 'applied', revertable: true }];

      const p1 = { kind: 'user', id: 'u-cont', checkpointId: 'cp-cont', text: 'Run task', at: 1_000 };
      const a1 = {
        kind: 'assistant',
        id: 'a-cont-1',
        attemptId: 'att-cont',
        turnId: 'turn-cont',
        text: 'Step 1.',
        at: 1_200,
      };
      const d1 = {
        kind: 'turndone',
        id: 'd-cont-1',
        status: 'done',
        verb: 'Completed',
        attemptId: 'att-cont',
        turnId: 'turn-cont',
        checkpointId: 'cp-cont',
        finalAssistantId: 'a-cont-1',
        at: 1_250,
      };
      // Timestamped tool (startedAt/at > d1.at) arriving one snapshot before the same-attempt assistant.
      const t2 = {
        kind: 'tool',
        id: 't-cont-2',
        ...(mode === 'same-turnId' ? { turnId: 'turn-cont' } : {}),
        name: 'edit',
        args: { file_path: 'src/a.ts' },
        result: 'ok',
        status: 'done',
        startedAt: 1_400,
        at: 1_400,
      };
      const a2 = {
        kind: 'assistant',
        id: 'a-cont-2',
        attemptId: 'att-cont',
        turnId: 'turn-cont',
        text: 'Step 2 complete.',
        at: 1_500,
      };
      const d2 = {
        kind: 'turndone',
        id: 'd-cont-2',
        status: 'done',
        verb: 'Completed',
        attemptId: 'att-cont',
        turnId: 'turn-cont',
        checkpointId: 'cp-cont',
        finalAssistantId: 'a-cont-2',
        at: 1_550,
      };

      // Frame 1: intermediate end d1 arrives while busy.
      await view.render({ items: [p1, a1, d1], busy: true, activityAt: 1_000 });
      assert.equal(view.cards(), 0, 'frame 1: no diff card at intermediate end');

      // Frame 2: ONLY the timestamped continuation tool arrives before a2.
      await view.render({ items: [p1, a1, d1, t2], busy: true, activityAt: 1_000 });
      assert.equal(
        view.rows.find((row) => row.key === 's1:a-cont-1')?.completion,
        undefined,
        'frame 2: intermediate d1 stays suppressed during tool-first same-attempt continuation'
      );
      assert.equal(view.cards(), 0, 'frame 2: zero diff-card flash on intermediate tool snapshot');

      // Frame 3: same-attempt assistant a2 arrives.
      await view.render({ items: [p1, a1, d1, t2, a2], busy: true, activityAt: 1_000 });
      assert.equal(
        view.rows.find((row) => row.key === 's1:a-cont-1')?.completion,
        undefined,
        'frame 3: intermediate d1 remains suppressed when a2 arrives'
      );
      assert.equal(view.cards(), 0, 'frame 3: still zero diff-card flash');

      // Frame 4: final end d2 settles and session goes idle -> single diff card on a2.
      await view.render({ items: [p1, a1, d1, t2, a2, d2], busy: false });
      assert.equal(view.cards(), 1, 'frame 4: single diff card once turn settles');
      assert.equal(view.document.querySelector('[data-row-key="s1:a-cont-1"] .turn-changes-card'), null);
      assert.ok(view.document.querySelector('[data-row-key="s1:a-cont-2"] .turn-changes-card'));
    });
  }
});

test('changing an untagged live reply timestamp across end.at does not flip card visibility when end lacks finalAssistantId', async (t) => {
  const runCase = async (st, liveAt, extraLive = {}) => {
    const view = await mountTranscriptPane(st);
    view.files = [{ path: 'src/a.ts', status: 'M', additions: 2, deletions: 1, state: 'applied', revertable: true }];
    const p1 = { kind: 'user', id: 'u-ts', checkpointId: 'cp-ts', text: 'Work', at: 1_000 };
    const a1 = { kind: 'assistant', id: 'a-ts-1', turnId: 'turn-ts-1', text: 'Done.', at: 1_200 };
    // End without finalAssistantId
    const d1 = {
      kind: 'turndone',
      id: 'd-ts-1',
      status: 'done',
      verb: 'Completed',
      turnId: 'turn-ts-1',
      checkpointId: 'cp-ts',
      at: 1_250,
    };
    await view.render({ items: [p1, a1, d1], busy: true, activityAt: 1_000 });
    assert.equal(view.cards(), 0, 'pre-live: d1 card waits while busy');
    await view.render({
      items: [p1, a1, d1],
      busy: true,
      activityAt: 1_000,
      liveItem: { kind: 'assistant', id: 'a-ts-live', text: 'Streaming...', streaming: true, at: liveAt, ...extraLive },
    });
    return view.cards();
  };

  let beforeEndCards = -1;
  let afterEndCards = -1;
  await t.test('untagged liveItem with at <= end.at', async (st) => {
    beforeEndCards = await runCase(st, 1_200);
  });
  await t.test('untagged liveItem with at > end.at', async (st) => {
    afterEndCards = await runCase(st, 1_400);
  });
  assert.equal(
    beforeEndCards,
    afterEndCards,
    'untagged liveItem timestamp crossing end.at must not flip card visibility'
  );
  assert.equal(beforeEndCards, 1, 'untagged liveItem is past d1 regardless of timestamp');

  // Contrast: explicit matching turnId keeps the live reply bound to d1 even when liveItem.at > d1.at.
  await t.test('matching turnId with at > end.at holds card', async (st) => {
    const cards = await runCase(st, 1_400, { turnId: 'turn-ts-1' });
    assert.equal(cards, 0, 'explicit matching turnId binds liveItem to d1 regardless of timestamp');
  });
});
