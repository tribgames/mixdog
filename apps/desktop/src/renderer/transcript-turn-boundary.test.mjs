// What stands around a turn's end, as the pane mounts it: the rows, the changed-files card and the reads the card makes.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TurnChangesContext } from './TurnChangesCard.tsx';
import { turnOf } from './conversation-turn-index.ts';
import { resetTurnChangesCache } from './turn-changes-model.ts';
import {
  claimTurnPreviewEnd,
  resetTurnPreviews,
  runningTurnKeyOf,
  turnPreviewOpenPending,
} from './turn-preview-model.ts';
import { trailingTurnRuns, useConversationLinkSurfaces } from './use-conversation-link-surfaces.ts';
import { useConversationRowRenderer } from './use-conversation-row-renderer.ts';
import { useTranscriptRows } from './use-conversation-rows.ts';

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

/** A pane's transcript over `props`: `items`, `busy`, `liveItem`, `activityAt` (0: no activity shown). The record of the
 *  turn's changes answers `pending` until `view.sealed`, as the core does while the turn still holds it. */
async function mountPane(t) {
  resetTurnChangesCache();
  resetTurnPreviews();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  const view = { sealed: false, reads: 0, read: [], rows: [], document };
  dom.window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability !== 'getTurnChanges') return { value: null };
      view.reads += 1;
      const checkpointId = request.args[0].checkpointId;
      view.read.push(checkpointId);
      const file = { path: 'src/a.ts', status: 'M', additions: 2, deletions: 1, state: 'applied', revertable: true };
      return {
        value: {
          status: view.sealed ? 'ready' : 'pending',
          checkpointId,
          revision: 1,
          root: 'C:/Project/app',
          files: view.sealed ? [file] : [],
          canUndo: true,
          canReapply: false,
        },
      };
    },
  };
  function Pane({ items, busy = false, liveItem = null, activityAt = 0, steerItems = [] }) {
    const { transcriptRows, settledTurnKeys, turnPastEnd, pastLastEnd } = useTranscriptRows({
      identity: 's1',
      sessionKey: 's1',
      settledItems: items,
      settledRowItems: items,
      failedTurnKeys: [],
      precomputedTurnKeys: null,
      pendingItems: [],
      steerItems,
      liveItem,
      busy,
      commandBusy: false,
      commandActivityVisible: activityAt > 0,
      commandActivityStartedAt: activityAt,
      optimisticActivityStartedAt: 0,
    });
    const links = useConversationLinkSurfaces(
      {},
      {
        turnChangesSessionId: 's1',
        turnChangesBusy: busy,
        turnChangesRunning: trailingTurnRuns(busy, 0, pastLastEnd),
        // As Conversation.tsx names the running turn.
        runningTurnKey: trailingTurnRuns(busy, 0, turnPastEnd)
          ? runningTurnKeyOf(items, settledTurnKeys, settledTurnKeys.at(-1) ?? '')
          : '',
      }
    );
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: { sessionId: 's1', busy },
      disclosureScope: 's1',
      readOnly: false,
      transitioning: false,
      renderAssistantRow: () => 'assistant',
      onOpenSettings() {},
      settledItems: items,
      settledTurnKeys,
      optimisticActivityStartedAt: 0,
      submit: async () => true,
      questionCard: null,
      agentMode: false,
    });
    view.rows = transcriptRows;
    return h(
      TurnChangesContext.Provider,
      { value: links.turnChangesSurface },
      transcriptRows.map((row, index) => h('div', { key: row.key }, renderTranscriptRow(row, index, transcriptRows)))
    );
  }
  view.root = root;
  view.Pane = Pane;
  view.render = async (props) => {
    await act(async () => root.render(h(Pane, props)));
    await settle();
  };
  view.tags = () => view.rows.map((row) => row._tag);
  view.card = () => document.querySelector('.turn-changes-card');
  view.cards = () => document.querySelectorAll('.turn-changes-card').length;
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
  await act(async () => view.root.render(h(view.Pane, { items: [...settled, wakeDone], busy: true, activityAt: 9_000 })));
  assert.equal(view.cards(), 1, 'never hidden between the two ends, nor while it is read again');
  await settle();
  assert.equal(view.cards(), 1);
  assert.equal(view.reads, 2, 'the newer end is read');
  await view.render({ items: [...settled, wakeDone], busy: false });
  assert.equal(view.cards(), 1);
});

test('an end that names a reply still arriving closes no earlier reply of its turn', async (t) => {
  const view = await mountPane(t);
  const first = { kind: 'assistant', id: 'first', text: 'I will check.', at: 1_500 };
  const tool = { kind: 'tool', id: 'tool', name: 'read', args: { file_path: 'a.ts' }, result: 'ok', completedAt: 2_000 };
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
  assert.deepEqual(view.tags(), ['UserMessage', 'AssistantPart'], 'no gap above the reply and no band under its footer');
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
    view.rows.slice(live + 1).map((row) => row._tag).filter((tag) => tag !== 'TurnGap'),
    ['UserMessage', 'Thinking']
  );
});
