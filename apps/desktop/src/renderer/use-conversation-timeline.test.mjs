import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { useConversationTimeline } from './use-conversation-timeline';
import { NOTIFICATION_JUMP_LATEST_EVENT } from './use-push-notification-navigation';
import { forgetTranscriptVirtualSnapshot, rememberTranscriptVirtualMeasurements } from './transcript-virtual-cache';
import { PaneKeyContext } from './pane-key-context';
import { openReaderPlace, readerPlace, useSessionEntry } from './transcript-list-reader-place';
import { transcriptTurnKeys } from './renderer-logic.mjs';
import { turnPromptText } from './transcript-rows';
import { useConversationRowRenderer } from './use-conversation-row-renderer';

const ITEMS = [
  { id: 'u1', kind: 'user', text: 'hello' },
  { id: 'a1', kind: 'assistant', text: 'hi' },
];

/** `submit`: the rows are also rendered, as Conversation.tsx renders them, and a row's retry submits through it. */
function mount(t, { showTimeline = true, items = ITEMS, pane = '', live = items, snapshot = {}, submit } = {}) {
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
  // What a case's lists left of their sessions is the renderer's, not the next case's.
  t.after(() => ['session-a', 'session-b'].forEach(forgetTranscriptVirtualSnapshot));
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
    follow: {
      following: true,
      hasScrollGesture: () => false,
      resume() {
        calls.resumed += 1;
      },
      arm() {
        calls.armed += 1;
      },
      pause() {
        calls.paused += 1;
      },
    },
  };
  const calls = { revealed: [], hidden: [], resumed: 0, armed: 0, paused: 0, anchored: [] };
  const identity = { current: 'entry' };
  const props = {
    view,
    source: {
      transcriptIdentity: identity,
      settledItems: items,
      liveSettledItems: live,
      settledRowItems: items,
      activeStreamingTail: null,
      showTranscriptTimeline: showTimeline,
      requestEarlierTranscript() {},
      resetTranscriptToLive() {},
    },
    sessionKey: 'session-a',
    draftMode: false,
    snapshot,
    pendingItems: [],
    optimisticActivityStartedAt: 0,
    onEntryRevealed: (key) => calls.revealed.push(key),
    onTranscriptHiddenChange: (hidden) => calls.hidden.push(hidden),
  };
  // In the order Conversation.tsx calls them: the entry, then the timeline.
  function Timeline() {
    useSessionEntry(props.sessionKey);
    calls.timeline = useConversationTimeline(props);
    calls.anchored.push(calls.timeline.shouldAnchorTranscriptBottom);
    return submit ? React.createElement(Rows, { timeline: calls.timeline }) : null;
  }
  function Rows({ timeline }) {
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: props.snapshot,
      disclosureScope: props.sessionKey,
      readOnly: false,
      transitioning: false,
      onOpenSettings() {},
      ...timeline.rowItems,
      optimisticActivityStartedAt: 0,
      submit,
      questionCard: null,
    });
    const rows = timeline.transcriptRows;
    return rows.map((row, index) =>
      React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows))
    );
  }
  const Harness = () => React.createElement(PaneKeyContext.Provider, { value: pane }, React.createElement(Timeline));
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
    window: document.defaultView,
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

test('a warm revisit reports hidden only until its first frame, with its dock segments still undecided', async (t) => {
  const entry = mount(t);
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  entry.visit('other');
  entry.tick(48);
  entry.tick(64);
  assert.equal(entry.hidden(), false);
  // The session left with its measured rows (TranscriptList's hand-over).
  rememberTranscriptVirtualMeasurements('session-a', [{ index: 0, key: 'u1', start: 0, size: 60, end: 60, lane: 0 }]);
  const segment = entry.window.document.createElement('span');
  segment.setAttribute('data-entry-pending', '');
  entry.window.document.getElementById('scope').append(segment);
  entry.visit('entry');
  assert.equal(entry.hidden(), true, 'hidden in the switch commit');
  await Promise.resolve();
  entry.tick(80);
  assert.equal(entry.hidden(), false, 'released in the first frame, inside the cover grace');
});

test('entering a session follows its end: the place its reader left in the pane is let go, not put back', (t) => {
  // What a list of the session tells as it leaves with its reader off the end: a place for the next list to put back.
  openReaderPlace('pane-1', 'session-a', { position: 'p:r10', top: -40 });
  const entry = mount(t, { pane: 'pane-1' });
  assert.equal(entry.calls.anchored[0], true, 'the entry commit anchors the list to the end');
  assert.ok(entry.calls.armed > 0, 'the entry arms follow');
  assert.equal(entry.calls.paused, 0, 'and never lets go of it');
  assert.equal(readerPlace('pane-1', 'session-a'), null, 'the old place is gone');
});

test('a history window and the live rows are each read with their own turn keys', (t) => {
  const history = [
    { id: 'u0', kind: 'user', text: 'an older prompt' },
    { id: 'a0', kind: 'assistant', text: 'an older reply' },
  ];
  // The state's keys are the live rows', here as many as the window's rows.
  const entry = mount(t, { items: history, live: ITEMS, snapshot: { transcriptTurnKeys: transcriptTurnKeys(ITEMS) } });
  const { settledTurnKeys, liveTurnKeys } = entry.calls.timeline;
  assert.deepEqual(settledTurnKeys, transcriptTurnKeys(history));
  assert.deepEqual(liveTurnKeys, transcriptTurnKeys(ITEMS));
  assert.equal(turnPromptText(history, settledTurnKeys, settledTurnKeys[0]), 'an older prompt');
  assert.equal(turnPromptText(ITEMS, liveTurnKeys, liveTurnKeys.at(-1)), 'hello');
});

test('an error only a history window holds offers Retry, which resubmits its own prompt', (t) => {
  const history = [
    { id: 'u0', kind: 'user', text: 'an older prompt' },
    { id: 'd0', kind: 'turndone', status: 'failed', message: 'The model stopped.' },
  ];
  const submitted = [];
  const entry = mount(t, {
    items: history,
    live: ITEMS,
    snapshot: { failedTurnKeys: [transcriptTurnKeys(history)[0]] },
    submit: async (prompt, options) => {
      submitted.push([prompt, options]);
      return true;
    },
  });
  const retry = [...entry.window.document.querySelectorAll('#root button')].find(
    (button) => button.textContent === 'Retry'
  );
  assert.ok(retry, 'the failed turn offers Retry');
  act(() => retry.click());
  assert.deepEqual(submitted, [['an older prompt', { retryFailedTurn: true }]]);
});

test('a tapped notification for this session returns the pane to its latest row; others do not', (t) => {
  const entry = mount(t);
  const jump = (sessionId) =>
    act(() => {
      entry.window.dispatchEvent(new entry.window.CustomEvent(NOTIFICATION_JUMP_LATEST_EVENT, { detail: sessionId }));
    });
  jump('session-b');
  assert.equal(entry.calls.resumed, 0);
  jump('session-a');
  assert.equal(entry.calls.resumed, 1);
});

test('a slow dock chrome holds the hidden report until it answers, however long that takes', (t) => {
  const entry = mount(t);
  entry.tick(16);
  entry.tick(60_000);
  assert.equal(entry.hidden(), true);
  assert.deepEqual(entry.calls.revealed, []);
  for (const marker of entry.window.document.querySelectorAll('[data-entry-pending]')) marker.remove();
  entry.tick(60_016);
  entry.tick(60_032);
  assert.equal(entry.hidden(), false);
  assert.deepEqual(entry.calls.revealed, ['session-a']);
});
