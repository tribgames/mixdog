// The spacing between rows of one turn belongs to the row below: appending a
// tool card, the next reply part or the live band must not change the box of
// a row that is already laid out (its new size landed a frame after the new
// row was placed, so every tool round shook the thread by 8px).
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const user = { _tag: 'UserMessage', key: 's:u', turnKey: 't', item: { kind: 'user', id: 'u', text: 'go' } };
const reply = { _tag: 'AssistantPart', key: 's:a1', turnKey: 't', item: { kind: 'assistant', id: 'a1', text: 'one' } };
const tools = { _tag: 'ToolActivity', key: 's:tools', turnKey: 't', items: [{ kind: 'tool', id: 'x', name: 'shell' }] };
const thinking = { _tag: 'Thinking', key: 's:thinking', turnKey: 't', active: true };
const final = { _tag: 'AssistantPart', key: 's:a2', turnKey: 't', item: { kind: 'assistant', id: 'a2', text: 'two' } };

async function withList(run) {
  const dom = new JSDOM("<div id='viewport'></div>", { url: 'http://localhost/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'HTMLElement', 'Element'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const viewport = dom.window.document.getElementById('viewport');
  for (const [name, value] of [
    ['clientHeight', 800],
    ['offsetHeight', 800],
    ['offsetWidth', 600],
    ['scrollHeight', 800],
  ]) {
    Object.defineProperty(viewport, name, { configurable: true, get: () => value });
  }
  // Row box heights by row key; every other box is 40px.
  const heights = new Map();
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = this === viewport ? 800 : (heights.get(this.textContent) ?? 40);
    return { top: 0, bottom: height, height, left: 0, right: 600, width: 600, x: 0, y: 0 };
  };
  for (const [key, value] of [
    ['window', dom.window],
    ['document', dom.window.document],
    ['ResizeObserver', FakeResizeObserver],
    ['HTMLElement', dom.window.HTMLElement],
    ['Element', dom.window.Element],
  ]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(viewport);
  try {
    const { TranscriptList } = await import('./TranscriptList.tsx');
    const render = (rows, renderRow = (row) => React.createElement('div', null, row.key)) =>
      act(async () => {
        root.render(
          React.createElement(TranscriptList, {
            sessionKey: 's',
            rows,
            viewport: { current: viewport },
            content: { current: null },
            shouldAnchorBottom: true,
            scrollToEndRef: { current: () => {} },
            renderRow,
            markProgrammaticScroll: () => {},
            hasScrollGesture: () => false,
            onSelectionAutoScroll: () => {},
          })
        );
      });
    const spacing = (key) => {
      const row = [...viewport.querySelectorAll('.transcript-virtual-row-content')].find(
        (node) => node.textContent === key
      );
      assert.ok(row, key);
      return {
        turnEnd: row.dataset.turnEnd ?? '',
        bandLead: row.dataset.bandLead ?? '',
        stepBefore: row.dataset.stepBefore ?? '',
      };
    };
    // A row's spacing marks by index (a row that renders nothing has no text).
    const marks = (index) => {
      const row = viewport.querySelector(`.transcript-virtual-row-content[data-index="${index}"]`);
      assert.ok(row, `row ${index}`);
      return Object.entries({ ...row.dataset })
        .filter(([name]) => name !== 'slot' && name !== 'index' && name !== 'tag')
        .map(([name]) => name)
        .sort()
        .join(' ');
    };
    const spacerHeight = () => viewport.querySelector('.transcript-virtual-space')?.style.height ?? '';
    await run({ render, spacing, marks, heights, spacerHeight });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('rows appended below a reply part or tool card leave the rows above unchanged', async () => {
  await withList(async ({ render, spacing }) => {
    await render([user, reply, thinking]);
    const replyBefore = spacing('s:a1');
    assert.equal(spacing('s:thinking').bandLead, 'true', 'the band leads in under the reply');

    await render([user, reply, tools, thinking]);
    assert.deepEqual(spacing('s:a1'), replyBefore, 'a tool card under the reply does not resize it');
    assert.equal(spacing('s:tools').stepBefore, 'true', 'the tool card carries the step itself');
    const toolsBefore = spacing('s:tools');

    await render([user, reply, tools, final, thinking]);
    assert.deepEqual(spacing('s:tools'), toolsBefore, 'the next reply part does not resize the tool card');
    assert.equal(spacing('s:a2').stepBefore, 'true');
    const finalBefore = spacing('s:a2');

    // The band leaves when the turn settles.
    await render([user, reply, tools, final]);
    assert.deepEqual(spacing('s:a2'), finalBefore, 'the settled reply keeps its box when the band goes');
    assert.deepEqual(spacing('s:u'), { turnEnd: '', bandLead: '', stepBefore: '' });
  });
});

// A bot chat renders a turn's tool rounds and its unfinished reply parts as
// nothing while the typing bubble (the band) stands for the reply. Those rows
// take no step, and the band and the reply that replaces it step from the row
// above that paints: stepping from the empty rows moved the typing bubble 8px
// per tool round (16px under the first part), and the reply then landed 16px
// above it, so the thread jumped while the reply was generated.
test('rows that render nothing take no step; the band and the reply step from the painted row above', async () => {
  await withList(async ({ render, marks }) => {
    const hidden = new Set(['s:tools', 's:a2']);
    const agentRow = (row) => (hidden.has(row.key) ? null : React.createElement('div', null, row.key));
    // Right after the prompt: the band takes no step.
    await render([user, thinking], agentRow);
    assert.equal(marks(1), 'turnEnd');
    // A reply part opens and a tool round runs, both unpainted: the band stays.
    await render([user, final, tools, thinking], agentRow);
    assert.equal(marks(1), 'blank');
    assert.equal(marks(2), 'blank');
    assert.equal(marks(3), 'turnEnd', 'the band keeps the step it had under the prompt');
    // The reply lands whole where the band stood: no step under the prompt.
    hidden.delete('s:a2');
    await render([user, tools, final, thinking], agentRow);
    assert.equal(marks(1), 'blank');
    assert.equal(marks(2), '', 'the reply steps from the prompt, not from the hidden tool round');
    assert.equal(marks(3), 'bandLead turnEnd');
    // Under a painted reply, hidden rows still leave the band its lead, and the
    // next reply its part step from that reply.
    hidden.add('s:a2');
    await render([user, reply, tools, final, thinking], agentRow);
    assert.equal(marks(2), 'blank');
    assert.equal(marks(3), 'blank');
    assert.equal(marks(4), 'bandLead turnEnd');
    hidden.delete('s:a2');
    await render([user, reply, tools, final, thinking], agentRow);
    assert.equal(marks(3), 'stepBefore');
  });
});

// A reaction-only turn (a hidden tool round, no reply) ends at the user row, so
// it takes the same end-of-turn spacing as any user row without a reply.
test('a user row followed only by rows that paint nothing ends its turn', async () => {
  await withList(async ({ render, marks }) => {
    const gap = { _tag: 'TurnGap', key: 's:gap', turnKey: 't2' };
    const user2 = { _tag: 'UserMessage', key: 's:u2', turnKey: 't2', item: { kind: 'user', id: 'u2', text: 'next' } };
    const agentRow = (row) => (row.key === 's:tools' ? null : React.createElement('div', null, row.key));
    await render([user, tools, gap, user2], agentRow);
    assert.equal(marks(0), 'turnEnd');
    // Still streaming: the live band below keeps the turn open.
    await render([user, tools, thinking], agentRow);
    assert.equal(marks(0), '');
  });
});

// At turn end the band row leaves and the reply above it takes the band's slot
// (its completion footer) in the same commit. The reply's new size must land
// in that commit too: left to the ResizeObserver, the total shrank by the band
// first and the followed tail painted a frame 40px low.
test('the reply that takes the leaving band slot is re-measured in the same commit', async () => {
  await withList(async ({ render, heights, spacerHeight }) => {
    await render([user, final, thinking]);
    const live = spacerHeight();
    assert.ok(live, 'the list wrote its extent');

    heights.set('s:a2', 80);
    await render([user, final]);
    assert.equal(spacerHeight(), live, 'the footer replaces the band without changing the extent');
  });
});
