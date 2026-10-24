// The timeline teaches the shared height store from its measured rows. An
// agent chat paints nothing for most tool rounds (a blank row, 0px): never
// learning that 0 estimated every unmeasured round at a coding tool card's
// height, and scrolling up through a bot chat's history corrected each one as
// it came into view (a 26px shift). The two surfaces learn apart.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><div id="root"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement'],
});

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useTranscriptRowEstimates, transcriptRowVariant } = await import('./transcript-list-estimates.ts');
const { TRANSCRIPT_ROW_ESTIMATE } = await import('./transcript-virtual-cache.ts');
const { transcriptRowHeightStore } = await import('./transcript-row-estimates.ts');

const WIDTH = 733;
// No session waits for the user.
const NONE = new Set();
const tools = (id) => ({
  _tag: 'ToolActivity',
  key: `est:tools:${id}`,
  turnKey: 't',
  items: [{ id: `est-${id}`, kind: 'tool' }],
});
const reply = (id) => ({
  _tag: 'AssistantPart',
  key: `est:${id}`,
  turnKey: 't',
  item: { id, kind: 'assistant', text: 'hi' },
});

async function mountEstimates(rows, surface) {
  const rowsRef = { current: rows };
  let estimates;
  const Probe = () => {
    estimates = useTranscriptRowEstimates({
      rowsRef,
      viewport: { current: null },
      hasScrollGestureRef: { current: () => false },
      surfaceRef: { current: surface },
    });
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Probe)));
  estimates.timelineWidth.current = WIDTH;
  const instance = {
    indexFromElement: (element) => Number(element.dataset.index),
    options: { getItemKey: (index) => rowsRef.current[index].key, anchorTo: 'start' },
    itemSizeCache: new Map(),
    measurementsCache: [],
  };
  // A laid-out row whose content box is `size` px tall; `blank` when it renders
  // nothing, `variant` the lines it painted (TranscriptList.tsx data-variant).
  const measure = (index, blank, size = 0, variant = '') => {
    const element = document.createElement('div');
    element.dataset.index = String(index);
    const content = document.createElement('div');
    if (blank) content.dataset.blank = 'true';
    if (variant) content.dataset.variant = variant;
    element.append(content);
    return estimates.measureRowSize(element, { borderBoxSize: [{ blockSize: size, inlineSize: WIDTH }] }, instance);
  };
  // A new snapshot of the rows (snapshots are immutable arrays).
  const setRows = (next) => {
    rowsRef.current = next;
  };
  return { estimates, measure, setRows, unmount: () => act(async () => root.unmount()) };
}

test('an agent chat learns a blank tool round as 0px; a coding list does not inherit it', async () => {
  const agent = await mountEstimates([tools(1), tools(2)], 'agent');
  assert.equal(agent.measure(0, true), 0);
  assert.equal(agent.estimates.estimateRow(1), 0, 'the next hidden round is estimated at 0px');
  await agent.unmount();
  const coding = await mountEstimates([tools(3)], 'coding');
  assert.equal(coding.estimates.estimateRow(0), TRANSCRIPT_ROW_ESTIMATE, 'coding estimates are unaffected');
  await coding.unmount();
});

test('a room’s live band starts empty; a bot chat’s starts as its typing bubble', async () => {
  const thinking = { _tag: 'Thinking', key: 'est:think', turnKey: 't', active: true };
  // Nobody types in a room until its supervisor picks a member: estimated at
  // a bubble, the band shrank to 0px and grew back as the typing came (60px
  // down and up right after sending).
  const room = await mountEstimates([thinking], 'room');
  assert.equal(room.estimates.estimateRow(0), 0);
  await room.unmount();
  const chat = await mountEstimates([{ ...thinking, key: 'est:think2' }], 'agent');
  assert.equal(chat.estimates.estimateRow(0), TRANSCRIPT_ROW_ESTIMATE);
  await chat.unmount();
});

// A tool round that handed work to a session, in a turn with no reply, paints
// its hand-off line (agent-chat-place.ts handoffLinesAt) until that session's
// report comes; the same round shape otherwise paints nothing.
const handoffRound = (id) => ({
  _tag: 'ToolActivity',
  key: `est:handoff:${id}`,
  turnKey: `h${id}`,
  items: [
    {
      id: `est-handoff-${id}`,
      kind: 'tool',
      name: 'session',
      args: { action: 'send', session_id: `sess_est_${id}`, prompt: 'go' },
      result: JSON.stringify({ accepted: true, sendId: `atask_${id}`, reportsBack: true }),
      status: 'done',
    },
  ],
});
const endReport = (id) => ({
  _tag: 'AssistantPart',
  key: `est:end:${id}`,
  turnKey: `e${id}`,
  item: {
    id: `est-end-${id}`,
    kind: 'notice',
    text: 'x',
    routine: { kind: 'task', status: 'completed', summary: 'ok', sessionId: `sess_est_${id}`, sendId: `atask_${id}` },
  },
});

test('a tool round painting a hand-off line is not estimated from hidden rounds’ 0px', async () => {
  const agent = await mountEstimates([tools(10), handoffRound(1)], 'agent');
  assert.equal(agent.measure(0, true), 0);
  assert.equal(agent.estimates.estimateRow(1) > 0, true, 'a round with a working line is not 0px');
  await agent.unmount();
});

test('after its report, the round estimates as a hidden round, not at its held line size', async () => {
  const rows = [tools(11), handoffRound(2), handoffRound(3)];
  const agent = await mountEstimates(rows, 'agent');
  agent.measure(0, true);
  const withLine = agent.estimates.estimateRow(1);
  assert.notEqual(withLine, 0);
  assert.equal(agent.measure(1, false, 30, 'lines:1'), 30);
  // Rounds with one line learn their own shape.
  assert.equal(agent.estimates.estimateRow(2), 30);
  // The session reported: the round paints nothing now.
  agent.setRows([...rows, endReport(2)]);
  assert.equal(agent.estimates.estimateRow(1), 0, 'the hidden shape, no stale held size');
  await agent.unmount();
});

test('a line round measured after its report landed is recorded under the line it painted', async () => {
  const rows = [tools(12), handoffRound(4)];
  const agent = await mountEstimates(rows, 'agent');
  agent.measure(0, true);
  // The report reaches the rows before the observer delivers the painted
  // line's 30px box.
  agent.setRows([...rows, endReport(4)]);
  assert.equal(agent.measure(1, false, 30, 'lines:1'), 30);
  assert.equal(agent.estimates.estimateRow(1), 0, 'the hidden round did not learn the line’s height');
  assert.equal(transcriptRowHeightStore().estimate(rows[1], WIDTH, 'agent', 'lines:1'), 30);
  await agent.unmount();
});

test('the rounds’ lines are worked out once per rows snapshot, not per round', async () => {
  // Many hand-offs, each answered: counting reads of the rows array shows a
  // per-round scan of the rows after it (quadratic) against one pass.
  const plain = [];
  for (let id = 100; id < 400; id += 1) plain.push(handoffRound(id), endReport(id));
  let reads = 0;
  const counted = new Proxy(plain, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const agent = await mountEstimates(counted, 'agent');
  for (let index = 0; index < plain.length; index += 1) agent.estimates.estimateRow(index);
  assert.ok(reads <= plain.length * 6, `${reads} reads of ${plain.length} rows`);
  await agent.unmount();
});

test('the row carrying a turn’s hand-off lines has their variant: the live band while it runs, then the reply', async () => {
  const round = { ...handoffRound(5), turnKey: 'turn5' };
  const answer = { ...reply('est-r5'), turnKey: 'turn5' };
  const band = { _tag: 'Thinking', key: 'est:think5', turnKey: 'turn5', active: true };
  for (const surface of ['agent', 'coding']) {
    const running = [round, answer, band];
    assert.deepEqual(
      running.map((_, index) => transcriptRowVariant(running, index, NONE)),
      ['', '', 'lines:1'],
      surface
    );
    // A live reply part of the turn carries it, from streaming on (the same
    // row key as the settled reply).
    const live = { ...answer, live: true, active: true, item: { ...answer.item, streaming: true } };
    const streamingRows = [round, live, band];
    assert.deepEqual(
      streamingRows.map((_, index) => transcriptRowVariant(streamingRows, index, NONE)),
      ['', 'lines:1', '']
    );
    const done = [round, answer];
    assert.deepEqual(
      done.map((_, index) => transcriptRowVariant(done, index, NONE)),
      ['', 'lines:1']
    );
    // The reply learned with its line: once the report ends the line, it is
    // estimated again, not held at the size it had with the line.
    const chat = await mountEstimates(done, surface);
    chat.estimates.estimateRow(1);
    assert.equal(chat.measure(1, false, 140, 'lines:1'), 140);
    assert.equal(transcriptRowHeightStore().estimate(answer, WIDTH, surface, 'lines:1'), 140);
    chat.setRows([...done, endReport(5)]);
    assert.equal(transcriptRowVariant([...done, endReport(5)], 1, NONE), '');
    const without = chat.estimates.estimateRow(1);
    assert.notEqual(without, 140, `${surface}: not the size it had with its line`);
    assert.equal(without, transcriptRowHeightStore().estimate(answer, WIDTH, surface, ''));
    await chat.unmount();
  }
});

test('a wait report its hand-off line carries is hidden: estimated at 0px under its own variant', async () => {
  const round = handoffRound(6);
  const wait = {
    ...endReport(6),
    key: 'est:wait:6',
    item: { ...endReport(6).item, id: 'est-wait-6', routine: { ...endReport(6).item.routine, status: 'blocked' } },
  };
  const rows = [round, wait];
  assert.equal(transcriptRowVariant(rows, 1, NONE), 'hidden');
  const chat = await mountEstimates(rows, 'agent');
  assert.equal(chat.estimates.estimateRow(1), 0);
  await chat.unmount();
  // With no line for its session it shows only while the session waits:
  // the variant follows that same decision, and the held estimate with it.
  assert.equal(transcriptRowVariant([wait], 0, new Set([wait.item.routine.sessionId])), '');
  assert.equal(transcriptRowVariant([wait], 0, NONE), 'hidden');
  const alone = await mountEstimates([wait], 'agent');
  assert.equal(alone.estimates.estimateRow(0), 0, 'not waiting: hidden, 0px');
  await alone.unmount();
});

test('a row that paints content is never learned at 0px', async () => {
  const agent = await mountEstimates([reply('r1'), reply('r2')], 'agent');
  agent.measure(0, false);
  assert.equal(agent.estimates.estimateRow(1), TRANSCRIPT_ROW_ESTIMATE);
  await agent.unmount();
});
