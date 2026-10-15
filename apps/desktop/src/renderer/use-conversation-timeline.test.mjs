import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ENTRY_CHROME_MAX_MS } from './use-transcript-reveal';
import { useConversationTimeline } from './use-conversation-timeline';

const ITEMS = [
  { id: 'u1', kind: 'user', text: 'hello' },
  { id: 'a1', kind: 'assistant', text: 'hi' },
];

function mount(t, { showTimeline = true, items = ITEMS } = {}) {
  let now = 0;
  let frameId = 0;
  const frames = new Map();
  const { root, document } = installTestDom(t, {
    html: '<!doctype html><div id="root"></div><section id="scope"><span hidden data-entry-pending></span><div id="viewport"><div id="content" style="height:100px"><div class="transcript-virtual-row" data-index="0" style="top:0px"></div></div></div></section>',
    rootId: 'root',
    globals: {
      requestAnimationFrame(callback) {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame(id) {
        frames.delete(id);
      },
    },
  });
  t.mock.method(performance, 'now', () => now);
  const viewport = { current: document.getElementById('viewport') };
  Object.defineProperties(viewport.current, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 100 },
  });
  const view = {
    viewport,
    content: { current: document.getElementById('content') },
    conversation: { current: document.getElementById('scope') },
    scrollToEndRef: { current: () => {} },
    follow: { following: true, hasScrollGesture: () => false, resume() {}, arm() {} },
  };
  const calls = { revealed: [], hidden: [] };
  const identity = { current: 'entry' };
  const props = {
    view,
    source: {
      transcriptIdentity: identity,
      settledItems: items,
      settledRowItems: items,
      activeStreamingTail: null,
      showTranscriptTimeline: showTimeline,
      requestEarlierTranscript() {},
    },
    sessionKey: 'session-a',
    draftMode: false,
    snapshot: {},
    pendingItems: [],
    optimisticActivityStartedAt: 0,
    onEntryRevealed: (key) => calls.revealed.push(key),
    onTranscriptHiddenChange: (hidden) => calls.hidden.push(hidden),
  };
  function Harness() {
    useConversationTimeline(props);
    return null;
  }
  act(() => root.render(React.createElement(Harness)));
  const tick = (time) => {
    now = time;
    act(() => {
      const scheduled = [...frames.values()];
      frames.clear();
      scheduled.forEach((callback) => {
        callback(time);
      });
    });
  };
  return {
    calls,
    tick,
    hidden: () => calls.hidden.at(-1),
    ready: () => document.querySelector('[data-entry-pending]').remove(),
    visit: (key) => {
      identity.current = key;
      act(() => root.render(React.createElement(Harness)));
    },
  };
}

for (const [name, options] of [
  ['a disabled reveal (timeline unavailable)', { showTimeline: false }],
  ['empty rows', { items: [] }],
]) {
  test(`${name} is not an entry and hides nothing`, (t) => {
    const entry = mount(t, options);
    entry.tick(16);
    entry.tick(32);
    assert.deepEqual(entry.calls.revealed, []);
    assert.equal(entry.hidden(), false);
  });
}

test('populated rows report hidden until revealed, and are recorded only then', (t) => {
  const entry = mount(t);
  entry.ready();
  assert.equal(entry.hidden(), true, 'hidden while the reveal settles');
  assert.deepEqual(entry.calls.revealed, []);
  entry.tick(16);
  entry.tick(32);
  assert.equal(entry.hidden(), false);
  assert.deepEqual(entry.calls.revealed, ['session-a']);
});

test('a revisit hides the transcript again and reports it until it reveals', (t) => {
  const entry = mount(t);
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  assert.equal(entry.hidden(), false);
  entry.visit('revisit');
  assert.equal(entry.hidden(), true);
  entry.tick(48);
  entry.tick(64);
  assert.equal(entry.hidden(), false);
});

test('a slow dock chrome releases the hidden report after the bound', (t) => {
  const entry = mount(t);
  entry.tick(16);
  entry.tick(ENTRY_CHROME_MAX_MS - 16);
  assert.equal(entry.hidden(), true);
  assert.deepEqual(entry.calls.revealed, []);
  entry.tick(ENTRY_CHROME_MAX_MS);
  entry.tick(ENTRY_CHROME_MAX_MS + 16);
  assert.equal(entry.hidden(), false);
  assert.deepEqual(entry.calls.revealed, ['session-a']);
});
