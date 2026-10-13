// Rows a compaction took out of the model context stay above the compaction
// divider as ordinary rows and offer no action that would act on model state.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { projectSettledTranscriptRows, transcriptRowArchived } from './transcript-rows.ts';
import { completionTone } from './transcript-primitives.tsx';
import { CompletionStatus } from './transcript-status.tsx';

const ITEMS = [
  { kind: 'user', id: 'arch1_0_1', text: 'old prompt', checkpointId: 'cp-old', archived: true },
  { kind: 'tool', id: 'arch1_1_1', name: 'apply_patch', args: {}, result: 'ok', archived: true },
  { kind: 'assistant', id: 'arch1_1_2', text: 'old reply', archived: true },
  { kind: 'turndone', id: 'arch1_1_3', status: 'complete', checkpointId: 'cp-old', archived: true },
  { kind: 'statusdone', id: 'arch1_divider', status: 'compacted', label: 'Conversation compacted' },
  { kind: 'user', id: 'u2', text: 'new prompt', checkpointId: 'cp-new' },
  { kind: 'assistant', id: 'a2', text: 'new reply' },
  { kind: 'turndone', id: 'd2', status: 'complete', checkpointId: 'cp-new' },
];

function project(items) {
  let turn = '';
  const turnKeys = items.map((item) => {
    if (item.kind === 'user') turn = `turn:${item.id}`;
    return turn;
  });
  return projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys, failedTurns: new Set() }).rows;
}

test('archived rows are marked, the divider and live rows are not, and archived turns get no changes card', () => {
  const rows = project(ITEMS).filter((row) => row._tag !== 'TurnGap');
  assert.deepEqual(
    rows.map((row) => [row.key, transcriptRowArchived(row)]),
    [
      ['s:arch1_0_1', true],
      ['s:arch1_1_1:tool-activity', true],
      ['s:arch1_1_2', true],
      ['s:arch1_divider', false],
      ['s:u2', false],
      ['s:a2', false],
    ]
  );
  // Undo/Reapply belong to the live turn only.
  assert.deepEqual(
    rows.filter((row) => row.turnChanges).map((row) => row.turnChanges.checkpointId),
    ['cp-new']
  );
});

test('the compaction boundary renders as the compaction divider', () => {
  for (const label of ['Conversation compacted', 'Auto-clear complete']) {
    const item = { kind: 'statusdone', id: 'd', status: 'compacted', label };
    assert.equal(completionTone(item), 'compaction');
    const markup = renderToStaticMarkup(React.createElement(CompletionStatus, { item }));
    assert.match(markup, /class="compaction-divider"/);
  }
});

test('the timeline renders archived rows like live rows, with no dimming marker or tooltip', async () => {
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
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = this === viewport ? 800 : 40;
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
    await act(async () => {
      root.render(
        React.createElement(TranscriptList, {
          sessionKey: 's',
          rows: project(ITEMS),
          viewport: { current: viewport },
          content: { current: null },
          shouldAnchorBottom: false,
          scrollToEndRef: { current: () => {} },
          renderRow: (row) => React.createElement('div', null, row.key),
          markProgrammaticScroll: () => {},
          hasScrollGesture: () => false,
          onSelectionAutoScroll: () => {},
        })
      );
    });
    const rendered = [...viewport.querySelectorAll('.transcript-virtual-row-content')];
    assert.ok(rendered.length >= 6);
    assert.ok(
      rendered.some((row) => row.textContent === 's:arch1_0_1'),
      'archived rows still render'
    );
    for (const row of rendered) {
      assert.equal(row.dataset.archived, undefined);
      assert.equal(row.getAttribute('title'), null);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
