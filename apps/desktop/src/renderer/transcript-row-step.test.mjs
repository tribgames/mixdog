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

test('a prompt keeps its room under a message sent while its turn runs, before and after the answer starts', async () => {
  await withList(async ({ render, spacing }) => {
    const gap = { _tag: 'TurnGap', key: 's:gap', turnKey: 't2' };
    const sent = {
      _tag: 'UserMessage',
      key: 's:u2',
      turnKey: 't2',
      item: { kind: 'user', id: 'u2', text: 'next', steer: 'pending' },
    };
    await render([user, thinking]);
    const room = spacing('s:u');
    await render([user, gap, sent, thinking]);
    assert.deepEqual(spacing('s:u'), room);
    await render([user, reply, gap, sent, thinking]);
    assert.deepEqual(spacing('s:u'), room);
  });
});

test('a compaction divider takes the working band’s seat, under a prompt and under the turn’s output', async () => {
  await withList(async ({ render, marks }) => {
    const divider = {
      _tag: 'AssistantPart',
      key: 's:divider',
      turnKey: 't',
      item: { kind: 'statusdone', id: 'divider:k1', status: 'compacted', label: 'Conversation compacted' },
    };
    await render([user, reply, tools, thinking]);
    const band = marks(3);
    assert.equal(band, 'bandLead turnEnd');
    // The turn's last act: the divider alone where the band stood.
    await render([user, reply, tools, divider]);
    assert.equal(marks(3), 'bandLead bandSeat');
    // Mid-turn: the band goes on under it.
    await render([user, reply, tools, divider, thinking]);
    assert.equal(marks(3), 'bandLead bandSeat');
    assert.equal(marks(4), band, 'the band leads in under the divider as it did under the tools');
    // Before the turn's first output.
    await render([user, thinking]);
    assert.equal(marks(1), 'turnEnd');
    await render([user, divider, thinking]);
    assert.equal(marks(1), 'bandSeat');
  });
});

test('the row under a divider stands a full step away, and a turn gap under a divider grows to that step', async () => {
  await withList(async ({ render, marks }) => {
    const statusRow = (id, item) => ({
      _tag: 'AssistantPart',
      key: `s:${id}`,
      turnKey: 't',
      item: { kind: 'statusdone', id, ...item },
    });
    const compacted = statusRow('compacted', { status: 'compacted', label: 'Conversation compacted' });
    const switched = statusRow('switched', { status: 'model-switched', modelId: 'm', provider: 'p' });
    const gap = (id) => ({ _tag: 'TurnGap', key: `s:gap:${id}`, turnKey: 't2' });
    const user2 = { _tag: 'UserMessage', key: 's:u2', turnKey: 't2', item: { kind: 'user', id: 'u2', text: 'next' } };
    // Inside a turn: the divider keeps the band's lead, and the reply under it carries the step in place of the part step.
    await render([user, reply, tools, compacted, final]);
    assert.equal(marks(3), 'bandLead bandSeat');
    assert.equal(marks(4), 'dividerStep');
    // Between turns: the gap above the divider stays as it stood, the one under it grows to the step, and neither
    // the divider nor the prompt adds one.
    await render([user, reply, gap(1), compacted, gap(2), user2]);
    assert.equal(marks(2), '');
    assert.equal(marks(3), 'bandSeat');
    assert.equal(marks(4), 'dividerGap');
    assert.equal(marks(5), 'turnEnd');
    // A session-level change is the same divider: a model switch above the prompt that follows it.
    await render([user, reply, gap(1), switched, user2]);
    assert.equal(marks(2), '');
    assert.equal(marks(3), 'bandSeat');
    assert.equal(marks(4), 'dividerStep turnEnd');
    // A gap between two ordinary turns keeps its own height.
    await render([user, reply, gap(1), user2]);
    assert.equal(marks(2), '');
  });
});

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
