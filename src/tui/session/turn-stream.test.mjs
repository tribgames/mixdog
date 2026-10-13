import assert from 'node:assert/strict';
import test from 'node:test';

import { compactionArchivedRows } from './compaction-view.mjs';
import { appendAssistantText, applyStageChange, createTurnStream } from './turn-stream.mjs';
import { createAskCallbacks } from '../../session-runtime/turn/turn-run/ask-callbacks.mjs';
import { createAskTranscriptMeta } from '../../runtime/agent/orchestrator/session/manager/ask-session.mjs';

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
  t.mock.timers.tick(1_000);
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 14s');
  t.mock.timers.tick(5_000);
  assert.equal(spinner().verb, 'Connection lost · retry 1/3 in 9s');

  await applyStageChange(stream, 'requesting');
  assert.equal(spinner().mode, 'requesting');
  const settled = spinner().verb;
  t.mock.timers.tick(3_000);
  assert.equal(spinner().verb, settled);
});

test('a reconnect notice without a retry time keeps its own message', async () => {
  const { stream, spinner } = streamWithSpinner();
  await applyStageChange(stream, 'reconnecting', { message: 'Reconnecting... 2/3' });
  assert.equal(spinner().verb, 'Reconnecting... 2/3');
});
