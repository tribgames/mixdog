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
const { useTranscriptRowEstimates } = await import('./transcript-list-estimates.ts');
const { TRANSCRIPT_ROW_ESTIMATE } = await import('./transcript-virtual-cache.ts');

const WIDTH = 733;
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
    options: { getItemKey: (index) => rows[index].key, anchorTo: 'start' },
    itemSizeCache: new Map(),
    measurementsCache: [],
  };
  // A laid-out row whose content box is 0px tall; `blank` when it renders nothing.
  const measure = (index, blank) => {
    const element = document.createElement('div');
    element.dataset.index = String(index);
    const content = document.createElement('div');
    if (blank) content.dataset.blank = 'true';
    element.append(content);
    return estimates.measureRowSize(element, { borderBoxSize: [{ blockSize: 0, inlineSize: WIDTH }] }, instance);
  };
  return { estimates, measure, unmount: () => act(async () => root.unmount()) };
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

test('a row that paints content is never learned at 0px', async () => {
  const agent = await mountEstimates([reply('r1'), reply('r2')], 'agent');
  agent.measure(0, false);
  assert.equal(agent.estimates.estimateRow(1), TRANSCRIPT_ROW_ESTIMATE);
  await agent.unmount();
});
