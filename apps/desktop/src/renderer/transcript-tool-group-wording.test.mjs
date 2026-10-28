// A tool group keeps its in-progress wording ("Run 1 command, Read file") for
// as long as its turn can still add calls to it. Between two calls of a turn
// every call of the group is finished for a moment (the model is deciding on
// the next one); the group then read "Ran 1 command" and flipped back to
// "Run 1 command, Read file" when the next call began, over and over while the
// agent worked. It reads finished once the turn no longer ends in the group.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { appendLiveTranscriptRows, projectSettledTranscriptRows, toolActivityStillOpen } from './transcript-rows.ts';
import { ToolActivityGroup } from './TranscriptView.tsx';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  dom.window.Element.prototype.getAnimations = () => [];
  dom.window.Document.prototype.getAnimations = () => [];
  const previous = new Map(
    [
      'window',
      'document',
      'navigator',
      'IS_REACT_ACT_ENVIRONMENT',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback) => setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id) => clearTimeout(id) });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    root: createRoot(dom.window.document.getElementById('root')),
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

// The render clock the readout test pins (`Date.now()` is what the group reads),
// so the start times below are exact offsets from it, not from a moving clock.
const NOW = 1_800_000_000_000;
const START = NOW - 1_000;
// Each call starts later than the one before it, as they do in a real turn;
// the group's readout counts from the first (the 'sh' call).
const STARTED = { sh: NOW - 40_500, rd: NOW - 30_500, gr: NOW - 20_500, ed: NOW - 20_500 };
const call = (id, name, args, done) => ({
  kind: 'tool',
  id,
  name,
  args,
  at: STARTED[id] ?? START,
  ...(done ? { result: 'ok', completedAt: START + 500 } : {}),
});
const sh = (done) => call('sh', 'shell', { command: 'npm test' }, done);
const read = (done) => call('rd', 'read', { file_path: 'a.ts' }, done);
const grep = (done) => call('gr', 'grep', { pattern: 'x' }, done);

// What the transcript holds at each step of a turn, in event order, with the
// rows the pane builds for it (the working row trails while the turn runs).
const TURN = [
  ['call A starts', [sh(false)], true],
  ['A finishes; the model is choosing the next call', [sh(true)], true],
  ['call B starts', [sh(true), read(false)], true],
  ['B finishes; the model is choosing again', [sh(true), read(true)], true],
  [
    'C and D run in parallel',
    [
      sh(true),
      read(true),
      grep(false),
      call('ed', 'edit', { file_path: 'b.ts', old_string: 'a', new_string: 'b' }, false),
    ],
    true,
  ],
  [
    'D finishes before C',
    [
      sh(true),
      read(true),
      grep(false),
      call('ed', 'edit', { file_path: 'b.ts', old_string: 'a', new_string: 'b' }, true),
    ],
    true,
  ],
  [
    'C finishes; nothing else started yet',
    [
      sh(true),
      read(true),
      grep(true),
      call('ed', 'edit', { file_path: 'b.ts', old_string: 'a', new_string: 'b' }, true),
    ],
    true,
  ],
  [
    'the turn ends',
    [
      sh(true),
      read(true),
      grep(true),
      call('ed', 'edit', { file_path: 'b.ts', old_string: 'a', new_string: 'b' }, true),
    ],
    false,
  ],
];

function rowsFor(items, busy, trailing = []) {
  const settled = projectSettledTranscriptRows({
    sessionKey: 's',
    items: [{ kind: 'user', id: 'u', text: 'go' }, ...items, ...trailing],
    turnKeys: ['t', ...items.map(() => 't'), ...trailing.map(() => 't')],
    failedTurns: new Set(),
  });
  return appendLiveTranscriptRows({ sessionKey: 's', settled, thinking: busy });
}

test('a group keeps its in-progress wording between calls and reads finished only when its turn ends', async () => {
  const dom = installDom();
  try {
    const recorded = [];
    for (const [step, items, busy] of TURN) {
      const rows = rowsFor(items, busy);
      const index = rows.findIndex((row) => row._tag === 'ToolActivity');
      const running = toolActivityStillOpen(rows, index, busy);
      await act(async () => {
        dom.root.render(React.createElement(ToolActivityGroup, { items, disclosureScope: 'wording', running }));
      });
      recorded.push([step, document.querySelector('.tool-activity-title b').textContent]);
    }
    assert.deepEqual(recorded, [
      ['call A starts', 'Run 1 command'],
      ['A finishes; the model is choosing the next call', 'Run 1 command'],
      ['call B starts', 'Run 1 command, Read file'],
      ['B finishes; the model is choosing again', 'Run 1 command, Read file'],
      ['C and D run in parallel', 'Edit 1 file, Run 1 command, Read file, Search code'],
      ['D finishes before C', 'Edit 1 file, Run 1 command, Read file, Search code'],
      ['C finishes; nothing else started yet', 'Edit 1 file, Run 1 command, Read file, Search code'],
      ['the turn ends', 'Edited 1 file, Ran 1 command, Read file, Searched code'],
    ]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('the group readout counts on from the first call through the gaps between calls', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dom = installDom();
  try {
    const recorded = [];
    for (const [step, items, busy] of TURN) {
      const rows = rowsFor(items, busy);
      const running = toolActivityStillOpen(
        rows,
        rows.findIndex((row) => row._tag === 'ToolActivity'),
        busy
      );
      await act(async () => {
        dom.root.render(React.createElement(ToolActivityGroup, { items, disclosureScope: 'readout', running }));
      });
      const shown = document.querySelector('.tool-activity-header .tool-working-elapsed')?.textContent ?? null;
      recorded.push([step, shown === null ? null : Number.parseInt(shown, 10)]);
    }
    const turnEnd = recorded.pop();
    assert.deepEqual(turnEnd, ['the turn ends', null], 'a finished group shows no readout, as before');
    for (const [step, seconds] of recorded) {
      assert.ok(seconds !== null, `${step}: the readout stays visible`);
      assert.equal(seconds, 40, `${step}: counts from the first call, not the latest (${seconds}s)`);
    }
    const seconds = recorded.map(([, value]) => value);
    assert.deepEqual(
      seconds,
      [...seconds].sort((a, b) => a - b),
      'never counts back'
    );
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('only the group the turn still ends in stays open to more calls', () => {
  const items = [sh(true), { kind: 'assistant', id: 'as', text: 'now reading' }, read(true)];
  const rows = rowsFor(items, true);
  const groups = rows.map((row, index) => [row._tag, index]).filter(([tag]) => tag === 'ToolActivity');
  assert.equal(groups.length, 2, 'text between calls splits the groups');
  assert.equal(toolActivityStillOpen(rows, groups[0][1], true), false, 'a group with a reply after it is closed');
  assert.equal(toolActivityStillOpen(rows, groups[1][1], true), true, 'the tail group of a running turn is open');
  assert.equal(toolActivityStillOpen(rows, groups[1][1], false), false, 'nothing is open once the turn is idle');
});
