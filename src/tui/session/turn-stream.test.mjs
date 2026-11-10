import assert from 'node:assert/strict';
import test from 'node:test';

import { compactionArchivedRows } from './compaction-view.mjs';
import { SPINNER_MODE_OVERRIDE_VERBS } from '../spinner-verbs.mjs';
import {
  appendAssistantText,
  appendTextDelta,
  applyStageChange,
  commitAssistantSegment,
  createTurnStream,
  flushStreamBatch,
  resetStreamedText,
  settleStreamingTailAtClose,
} from './turn-stream.mjs';
import { createProjection } from '../../standalone/session-proxy/projection.mjs';
import { diffSessionState } from '../../standalone/session-state-patch.mjs';
import { failTurn, streamHandlers, toolHandlers } from './turn.mjs';
import { createAskCallbacks } from '../../session-runtime/turn/turn-run/ask-callbacks.mjs';
import { createAskTranscriptMeta } from '../../runtime/agent/orchestrator/session/manager/ask-session.mjs';

test('a preamble settles as soon as the provider streams a tool call, not after the whole response', () => {
  const settled = [];
  let sealed = 0;
  let committed = 0;
  let state = {};
  let sequence = 0;
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `row_${++sequence}`,
    isCurrentTurn: () => true,
    transcriptMeta: {},
    routeMeta: {},
    updateStreamingTail: () => {},
    settleStreamingTail: (id, patch) => settled.push({ id, ...patch }),
    clearStreamingTail: () => {},
    sealToolBlock: () => {
      sealed += 1;
    },
  });
  const handlers = toolHandlers({
    stream,
    isCurrentTurn: () => true,
    markPromptCommitted: () => {
      committed += 1;
    },
  });
  appendTextDelta(stream, 'Let me look at the layout first');
  handlers.onAssistantToolCallObserved({ id: 'call_1', name: 'list' });
  assert.deepEqual(
    settled.map((row) => row.text),
    ['Let me look at the layout first']
  );
  assert.equal(sealed, 1);
  assert.equal(committed, 1);
  assert.deepEqual(stream.committedSegments, ['Let me look at the layout first']);
  // A second call of the same response finds nothing left to settle.
  handlers.onAssistantToolCallObserved({ id: 'call_2', name: 'list' });
  assert.equal(settled.length, 1);
  // The response's content, surfaced before its tool calls open, is the same
  // text: it opens no second row.
  streamHandlers({ stream, isCurrentTurn: () => true, markPromptCommitted: () => {} }).onAssistantText(
    'Let me look at the layout first'
  );
  assert.equal(stream.currentAssistantText, '');
  assert.equal(stream.currentAssistantId, null);
  flushStreamBatch(stream);
});

function liveStream() {
  const settled = [];
  let state = {};
  let sequence = 0;
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `row_${++sequence}`,
    isCurrentTurn: () => true,
    transcriptMeta: {},
    routeMeta: {},
    updateStreamingTail: (id, patch) => {
      const current = state.streamingTail?.id === id ? state.streamingTail : {};
      state = { ...state, streamingTail: { ...current, ...patch, kind: 'assistant', id, streaming: true } };
    },
    settleStreamingTail: (id, patch) => settled.push({ id, ...patch }),
    clearStreamingTail: () => {},
    sealToolBlock: () => {},
  });
  const handlers = streamHandlers({ stream, isCurrentTurn: () => true, markPromptCommitted: () => {} });
  return { stream, settled, handlers, state: () => state };
}

test('a reasoning retraction clears the discarded attempt thinking so a retry shows only its own', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, handlers, state } = liveStream();
  handlers.onReasoningDelta('attempt one thinking');
  flushStreamBatch(stream);
  assert.equal(state().thinking, 'attempt one thinking');
  // The provider re-issues the request: it retracts thinking only, no answer text.
  assert.equal(handlers.onTextReset({ chars: 0, reasoning: true, reason: 'gemini-stream-retry' }), true);
  assert.equal(state().thinking, null);
  handlers.onReasoningDelta('attempt two thinking');
  flushStreamBatch(stream);
  assert.equal(stream.thinkingText, 'attempt two thinking');
  assert.equal(state().thinking, 'attempt two thinking');
});

test('a reasoning retraction drops only the failed attempt, keeping earlier sends thinking', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, handlers } = liveStream();
  // Send 1 thinks and settles.
  handlers.onProviderSendStarted();
  handlers.onReasoningDelta('first send thinking. ');
  flushStreamBatch(stream);
  // Send 2: attempt A thinks, is retracted, attempt B thinks.
  handlers.onProviderSendStarted();
  handlers.onReasoningDelta('attempt A thinking. ');
  flushStreamBatch(stream);
  assert.equal(stream.thinkingText, 'first send thinking. attempt A thinking. ');
  assert.equal(handlers.onTextReset({ chars: 0, reasoning: true, reason: 'gemini-stream-retry' }), true);
  assert.equal(stream.thinkingText, 'first send thinking. ');
  handlers.onReasoningDelta('attempt B thinking.');
  flushStreamBatch(stream);
  assert.equal(stream.thinkingText, 'first send thinking. attempt B thinking.');
  // A second retraction of the same send still keeps send 1.
  handlers.onTextReset({ chars: 0, reasoning: true });
  assert.equal(stream.thinkingText, 'first send thinking. ');
});

test("a tool call's start settles the preamble before its arguments stream", () => {
  const { stream, settled, handlers } = liveStream();
  appendTextDelta(stream, 'Let me check the layout');
  handlers.onStreamItemStart({ kind: 'tool' });
  assert.deepEqual(
    settled.map((row) => row.text),
    ['Let me check the layout']
  );
  // The response's own content, surfaced before its tool calls open, opens no
  // second row.
  handlers.onAssistantText('Let me check the layout');
  assert.equal(stream.currentAssistantText, '');
  assert.equal(stream.currentAssistantId, null);
});

test('a phased message marks its live row; a message of another phase opens its own row', () => {
  const { stream, settled, handlers, state } = liveStream();
  handlers.onStreamItemStart({ kind: 'text', phase: 'commentary' });
  appendTextDelta(stream, 'Checking');
  flushStreamBatch(stream);
  assert.equal(state().streamingPartial.tail.phase, 'commentary', 'the row the partial line opens');
  appendTextDelta(stream, ' the config\n');
  flushStreamBatch(stream);
  assert.equal(state().streamingTail.phase, 'commentary');
  handlers.onStreamItemStart({ kind: 'text', phase: 'final_answer' });
  assert.deepEqual(
    settled.map((row) => row.text),
    ['Checking the config\n']
  );
  appendTextDelta(stream, 'The answer\n');
  flushStreamBatch(stream);
  assert.equal(state().streamingTail.phase, 'final_answer');
  assert.notEqual(state().streamingTail.id, settled[0].id);
});

test('a phase named only on the finished message tags the open row without splitting it', () => {
  const { stream, settled, handlers, state } = liveStream();
  appendTextDelta(stream, 'Looking around\n');
  flushStreamBatch(stream);
  assert.equal(state().streamingTail.phase, undefined);
  handlers.onStreamItemStart({ kind: 'text', phase: 'commentary' });
  assert.equal(settled.length, 0);
  assert.equal(state().streamingTail.phase, 'commentary');
  handlers.onStreamItemStart({ kind: 'text', phase: 'unknown' });
  assert.equal(stream.phase, 'commentary', 'an unknown phase is ignored');
});

test('the turn hands the provider item-start hook to the ask loop', () => {
  const onStreamItemStart = () => {};
  const { askCallbacks } = createAskCallbacks({
    transcript: { appendAssistantText() {} },
    notifyFnForSession: () => null,
    scheduleSearchRuntimeWarmup: null,
    hooks: { emit() {} },
  });
  const callbacks = askCallbacks({ snapshot: {}, timing: {}, signal: null }, { id: 's1' }, { onStreamItemStart });
  assert.equal(callbacks.onStreamItemStart, onStreamItemStart);
});

test('a non-streaming continuation row carries the persisted message id, so live and restart classify alike', () => {
  const raw = { sender: 'me' };
  const ask = createAskTranscriptMeta(raw);
  // The runtime persists the continuation first (taking its id) ...
  const persisted = ask.takeAssistant();
  // ... then surfaces its text to the live row.
  const rows = [];
  let state = {};
  let sequence = 0;
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `row_${++sequence}`,
    isCurrentTurn: () => true,
    transcriptMeta: raw,
    routeMeta: {},
    updateStreamingTail: (id, patch) => rows.push({ kind: 'assistant', id, ...patch }),
  });
  appendAssistantText(stream, 'continued answer\n', { committed: true });
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].messageId, persisted.messageId);
  assert.equal(rows[0].at, persisted.at);
  // Compaction drops the persisted message: the restart row (same message id)
  // and the live row classify the same.
  const archived = compactionArchivedRows({
    droppedMessages: 1,
    droppedIdentities: { messageIds: [persisted.messageId], callIds: [] },
  });
  const restored = { kind: 'assistant', id: 'restored', messageId: persisted.messageId };
  assert.equal(archived(rows[0]), true);
  assert.equal(archived(restored), true);
  // The next reply still gets its own id.
  assert.notEqual(ask.takeAssistant().messageId, persisted.messageId);
});

test('a tool preamble published before its own commit never claims an earlier text-less commit id', () => {
  const raw = { sender: 'me' };
  const ask = createAskTranscriptMeta(raw);
  // A text-less message commits (no text ever reaches the row) ...
  const textless = ask.takeAssistant();
  assert.ok(raw.persistedAssistant);
  // ... then the next round's non-streaming preamble is published BEFORE its
  // own message commits (runToolPhase order).
  const rows = [];
  let state = {};
  let sequence = 0;
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `row_${++sequence}`,
    isCurrentTurn: () => true,
    transcriptMeta: raw,
    routeMeta: {},
    updateStreamingTail: (id, patch) => rows.push({ kind: 'assistant', id, ...patch }),
  });
  appendAssistantText(stream, 'preamble\n');
  const row = rows.find((candidate) => candidate.messageId);
  assert.notEqual(row.messageId, textless.messageId);
  assert.equal(raw.persistedAssistant ?? null, null);
  // The preamble's own message then commits under the id the row minted.
  const own = ask.takeAssistant();
  assert.equal(own.messageId, row.messageId);
  // Live and restart agree: dropping the text-less message leaves the row
  // live; dropping the preamble's message archives it.
  const dropTextless = compactionArchivedRows({
    droppedMessages: 1,
    droppedIdentities: { messageIds: [textless.messageId], callIds: [] },
  });
  assert.equal(dropTextless(row), false);
  assert.equal(dropTextless({ kind: 'assistant', id: 'restored', messageId: own.messageId }), false);
  const dropOwn = compactionArchivedRows({
    droppedMessages: 1,
    droppedIdentities: { messageIds: [own.messageId], callIds: [] },
  });
  assert.equal(dropOwn(row), true);
  assert.equal(dropOwn({ kind: 'assistant', id: 'restored', messageId: own.messageId }), true);
});

test('the ask-callbacks bridge forwards { committed }, so a committed continuation reuses the persisted id', () => {
  const raw = { sender: 'me' };
  const ask = createAskTranscriptMeta(raw);
  const persisted = ask.takeAssistant();
  const rows = [];
  let state = {};
  let sequence = 0;
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `row_${++sequence}`,
    isCurrentTurn: () => true,
    transcriptMeta: raw,
    routeMeta: {},
    updateStreamingTail: (id, patch) => rows.push({ kind: 'assistant', id, ...patch }),
  });
  const { askCallbacks } = createAskCallbacks({
    transcript: { appendAssistantText() {} },
    notifyFnForSession: () => null,
    scheduleSearchRuntimeWarmup: null,
    hooks: { emit() {} },
  });
  const callbacks = askCallbacks(
    { snapshot: { promise: null }, timing: {}, signal: null },
    { id: 's' },
    {
      transcriptMeta: raw,
      // Same shape as turn.mjs onAssistantText.
      onAssistantText: (text, detail) => appendAssistantText(stream, text, { committed: detail?.committed === true }),
    }
  );
  callbacks.onAssistantText('continued answer\n', { committed: true });
  const row = rows.find((candidate) => candidate.messageId);
  assert.equal(row.messageId, persisted.messageId);
  const drop = compactionArchivedRows({
    droppedMessages: 1,
    droppedIdentities: { messageIds: [persisted.messageId], callIds: [] },
  });
  assert.equal(drop(row), true);
  assert.equal(drop({ kind: 'assistant', id: 'restored', messageId: persisted.messageId }), true);
});

function streamWithSpinner() {
  let state = { spinner: { mode: 'requesting' } };
  const stream = createTurnStream({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    isCurrentTurn: () => true,
  });
  return { stream, spinner: () => state.spinner };
}

test('a reconnect wait counts down live and stops once the stage moves on', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const { stream, spinner } = streamWithSpinner();
  await applyStageChange(stream, 'reconnecting', {
    attempt: 1,
    max: 3,
    reason: 'Connection lost',
    retryAt: 1_000_000 + 15_000,
    message: 'Connection lost · retry 1/3 in 15s',
  });
  assert.equal(spinner().mode, 'reconnecting');
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 15s');
  // The wait rides on the spinner for surfaces that recount it on their own
  // repaint clock (desktop status line): relative remaining time, plus the
  // retry's identity.
  assert.equal(spinner().retryAt, 1_000_000 + 15_000);
  assert.equal(spinner().retryInMs, 15_000);
  t.mock.timers.tick(1_000);
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 14s');
  assert.equal(spinner().retryInMs, 14_000);
  t.mock.timers.tick(5_000);
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 9s');

  await applyStageChange(stream, 'requesting');
  assert.equal(spinner().mode, 'requesting');
  const settled = spinner().verb;
  t.mock.timers.tick(3_000);
  assert.equal(spinner().verb, settled);
});

// The store side of a live turn: every set() is one published snapshot.
function liveTurnStream({ isCurrentTurn = () => true } = {}) {
  let state = {};
  const published = [];
  let sequence = 0;
  const set = (patch) => {
    state = { ...state, ...patch };
    published.push({ at: Date.now(), patch, state });
    return true;
  };
  const stream = createTurnStream({
    getState: () => state,
    set,
    nextId: () => `row_${++sequence}`,
    isCurrentTurn,
    transcriptMeta: {},
    routeMeta: { model: 'm' },
    updateStreamingTail: (id, patch = {}, extra = {}) =>
      set({
        streamingTail: {
          ...(state.streamingTail?.id === id ? state.streamingTail : {}),
          ...patch,
          kind: 'assistant',
          id,
          streaming: true,
        },
        ...extra,
      }),
    settleStreamingTail: (id, patch = {}) => {
      if (state.streamingTail?.id !== id) return false;
      set({
        items: [...(state.items || []), { ...state.streamingTail, ...patch, streaming: false }],
        streamingTail: null,
      });
      return true;
    },
    clearStreamingTail: () => set({ streamingTail: null }),
    sealToolBlock: () => {},
  });
  return { stream, published, state: () => state, set };
}

// failTurn, then the close-time settle publishTurnClose runs (turn.mjs).
function failThenClose(stream, error) {
  const ctx = {
    turn: {},
    stream,
    cards: { aggregates: { finalizeToolHeaders() {} }, flushToolResults() {} },
    pushNotice() {},
  };
  failTurn(ctx, error);
  settleStreamingTailAtClose(stream);
  return ctx.turn;
}

test('a turn that fails before its first newline keeps the visible unfinished text as its row', () => {
  for (const error of [new Error('provider stream reset'), new Error('tool loop aborted: too many iterations')]) {
    const { stream, state } = liveTurnStream();
    appendTextDelta(stream, 'visible unfinished reply');
    // Fails before any partial tick: the forced flush publishes it first.
    const turn = failThenClose(stream, error);
    assert.equal(turn.failed, true);
    assert.deepEqual(
      state().items.map((item) => [item.kind, item.text, item.streaming]),
      [['assistant', 'visible unfinished reply', false]]
    );
    assert.equal(state().streamingPartial, null);
    assert.equal(state().streamingTail, null);
  }
});

test('a cancelled mid-line turn keeps its text once; a replaced transcript or a closed session stays as it is', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const cancelled = liveTurnStream();
  appendTextDelta(cancelled.stream, 'half a line');
  failThenClose(cancelled.stream, abort);
  assert.deepEqual(
    cancelled.state().items.map((item) => item.text),
    ['half a line']
  );
  assert.equal(cancelled.state().streamingPartial, null);

  // A transcript replacement (session reset) cleared the partial: no resurrection.
  const replaced = liveTurnStream();
  appendTextDelta(replaced.stream, 'gone with the reset');
  flushStreamBatch(replaced.stream);
  replaced.set({ items: [], streamingTail: null, streamingPartial: null });
  failThenClose(replaced.stream, new Error('provider stream reset'));
  assert.deepEqual(replaced.state().items, []);
  assert.equal(replaced.state().streamingPartial, null);

  // The session closed mid-line: a stale turn writes nothing at all.
  let current = true;
  const closed = liveTurnStream({ isCurrentTurn: () => current });
  appendTextDelta(closed.stream, 'mid line');
  flushStreamBatch(closed.stream);
  const before = closed.state();
  current = false;
  failThenClose(closed.stream, new Error('session closed'));
  assert.equal(closed.state(), before);
});

const deltas = (text, size) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

test('the unfinished line reaches the desktop at a coalesced 40 ms cadence while the tail stays line-gated', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, published, state } = liveTurnStream();
  const reply = 'First streamed line of the reply\nSecond line keeps coming without a break yet';
  // What the frame-batched store emits: the state after each slice of time.
  const frames = [];
  for (const chunk of deltas(reply, 2)) {
    appendTextDelta(stream, chunk);
    for (let step = 0; step < 4; step += 1) {
      t.mock.timers.tick(5);
      frames.push(state());
    }
  }
  t.mock.timers.tick(100);
  frames.push(state());
  const partials = published.filter((entry) => Object.hasOwn(entry.patch, 'streamingPartial'));
  // The first chunk shows on the next frame, before its line completes, as
  // the row's opening text with the identity the row will keep.
  const [first] = partials;
  assert.ok(first.at - 1_000_000 <= 10, `first partial after ${first.at - 1_000_000} ms`);
  assert.equal(first.state.streamingTail, undefined);
  assert.equal(first.state.streamingPartial.from, 0);
  assert.equal(first.state.streamingPartial.tail.id, first.state.streamingPartial.id);
  assert.equal(first.state.streamingPartial.tail.model, 'm');
  const gaps = partials
    .slice(1)
    .map((entry, index) => entry.at - partials[index].at)
    .sort((a, b) => a - b);
  assert.ok(gaps.length >= 15, `only ${gaps.length + 1} partial publications`);
  const median = gaps[Math.floor(gaps.length / 2)];
  assert.ok(median >= 30 && median <= 60, `median gap ${median}`);
  assert.ok(gaps.at(-1) <= 60, `max gap ${gaps.at(-1)}`);
  // Every emitted frame: the tail holds completed lines only, and the
  // partial continues exactly that tail.
  for (const snapshot of frames) {
    const tailText = snapshot.streamingTail?.text ?? '';
    assert.ok(tailText === '' || tailText.endsWith('\n'), JSON.stringify(tailText));
    const partial = snapshot.streamingPartial;
    if (!partial) continue;
    assert.equal(partial.from, tailText.length);
    if (snapshot.streamingTail) assert.equal(partial.id, snapshot.streamingTail.id);
    assert.ok(reply.startsWith(tailText + partial.text));
  }
  assert.equal(state().streamingTail.text, 'First streamed line of the reply\n');
  assert.equal(state().streamingTail.id, first.state.streamingPartial.id);
  assert.equal(state().streamingPartial.text, 'Second line keeps coming without a break yet');
});

test('tool boundaries and turn end flush the partial line at once, then clear it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, state } = liveTurnStream();
  appendTextDelta(stream, 'Let me check');
  // A tool call arrives before any timer fired.
  flushStreamBatch(stream);
  assert.equal(state().streamingPartial.text, 'Let me check');
  const rowId = state().streamingPartial.id;
  commitAssistantSegment(stream, { sealToolBlock: true });
  assert.equal(state().streamingPartial, null);
  assert.deepEqual(
    state().items.map((item) => [item.id, item.text]),
    [[rowId, 'Let me check']]
  );
  t.mock.timers.tick(200);
  assert.equal(state().streamingPartial, null);
  appendTextDelta(stream, 'Done.\nAll');
  t.mock.timers.tick(10);
  assert.equal(state().streamingTail.text, 'Done.\n');
  assert.equal(state().streamingPartial.text, 'All');
  // A retraction (provider retry) reaches the partial line in the same frame.
  resetStreamedText(stream, { chars: 2 });
  assert.equal(state().streamingPartial, null);
  appendTextDelta(stream, 'l good');
  settleStreamingTailAtClose(stream);
  assert.equal(state().streamingPartial, null);
  assert.equal(state().items.at(-1).text, 'Done.\nAl good');
});

test('the terminal view never holds the partial line and never re-renders for it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { stream, published } = liveTurnStream();
  const projection = createProjection({ binding: { attachment: 'a', sessionId: 's', disposed: false }, log: () => {} });
  let emits = 0;
  projection.subscribe(() => {
    emits += 1;
  });
  let previous = { sessionId: 's', items: [] };
  projection.applyBody({ revision: 1, full: previous }, 'a');
  for (const chunk of deltas('one line\nand an unfinished one', 2)) {
    appendTextDelta(stream, chunk);
    t.mock.timers.tick(15);
  }
  t.mock.timers.tick(100);
  let revision = 1;
  const tailTexts = [];
  for (const { state } of published) {
    const next = { sessionId: 's', items: [], ...state };
    revision += 1;
    assert.equal(
      projection.applyBody({ revision, baseRevision: revision - 1, patch: diffSessionState(previous, next) }, 'a'),
      true
    );
    previous = next;
    assert.equal(Object.hasOwn(projection.getState(), 'streamingPartial'), false);
    tailTexts.push(projection.getState().streamingTail?.text ?? '');
  }
  // Only line-gated changes reached the terminal; partial-only frames advanced silently.
  assert.deepEqual([...new Set(tailTexts)], ['', 'one line\n']);
  assert.ok(emits < published.length, `${emits} emits for ${published.length} frames`);
  // A full body from a desktop-capable daemon is stripped too.
  projection.applyBody(
    { revision: revision + 1, full: { sessionId: 's', items: [], streamingPartial: { id: 'x', from: 0, text: 'y' } } },
    'a'
  );
  assert.equal(Object.hasOwn(projection.getState(), 'streamingPartial'), false);
});

test('a sent request waiting for headers shows the model-thinking mode until the stream starts', async () => {
  const { stream, spinner } = streamWithSpinner();
  await applyStageChange(stream, 'requesting');
  await applyStageChange(stream, 'model_thinking');
  assert.equal(spinner().mode, 'model-thinking');
  assert.equal(SPINNER_MODE_OVERRIDE_VERBS[spinner().mode], 'Model thinking');
  await applyStageChange(stream, 'streaming');
  assert.equal(spinner().mode, 'responding');
});

test('a reconnect notice without a retry time keeps its own message', async () => {
  const { stream, spinner } = streamWithSpinner();
  await applyStageChange(stream, 'reconnecting', { message: 'Reconnecting... 2/3' });
  assert.equal(spinner().verb, 'Reconnecting... 2/3');
});
