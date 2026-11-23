// The end of a turn the user's own message took over ("Send now") against one the user stopped: live, and read again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSteadyFrames, mountTranscriptPane } from './test-support/transcript-pane.mjs';

const prompt = { kind: 'user', id: 'u1', text: 'Change the files', checkpointId: 'cp', at: 1_000 };
const tool = {
  kind: 'tool',
  id: 't1',
  name: 'apply_patch',
  args: { path: 'src/a.ts' },
  result: 'ok',
  callId: 'c1',
  at: 2_000,
};
const elapsedMs = 868_000;
/** The live end the core shows (`live_end_row`): the turn's duration, verb and checkpoint; `cause` when a message took over. */
const liveEnd = (cause) => ({
  kind: 'turndone',
  id: 'end-live',
  status: 'cancelled',
  elapsedMs,
  verb: 'Thought',
  checkpointId: 'cp',
  toolCount: 1,
  at: 869_000,
  ...(cause ? { cause } : {}),
});
/** The end a reload reads back from the completion recorded on the turn's last row (`turn_done`). */
const restoredEnd = (cause) => ({
  kind: 'turndone',
  id: 'u1:2',
  status: 'cancelled',
  elapsedMs,
  verb: 'Thought',
  checkpointId: 'cp',
  at: 1_000,
  ...(cause ? { cause } : {}),
});
/** A user Stop with nothing queued: the history holds the interruption marker, read back as a cancelled end. */
const markerEnd = { kind: 'turndone', id: 'marker', status: 'cancelled', elapsedMs: 0 };
const next = { kind: 'user', id: 'u2', text: 'Use the other file', at: 869_500 };
const reply = { kind: 'assistant', id: 'a2', text: 'Done.', at: 900_000 };
const done = {
  kind: 'turndone',
  id: 'd2',
  status: 'done',
  verb: 'Thought',
  checkpointId: 'u2',
  finalAssistantId: 'a2',
  elapsedMs: 30_000,
  at: 900_000,
};

/** The row the end of turn `u1` is drawn in: the one that follows its tool group. */
function endRowText(view) {
  const frame = view.frame();
  const at = frame.findIndex((row) => row.tag === 'ToolActivity');
  return frame
    .slice(at + 1)
    .filter((row) => row.tag !== 'UserMessage' && row.tag !== 'TurnGap')
    .map((row) => row.text)[0];
}

function assertQuietEnd(view, when) {
  const text = endRowText(view);
  assert.ok(text, `${when}: the turn's end is drawn`);
  assert.doesNotMatch(text, /Cancel|Interrupt/i, `${when}: no cancelled wording: ${text}`);
  assert.match(text, /Thought for 14m 28s/, `${when}: its duration: ${text}`);
  assert.equal(view.status('.turn-status.interrupted').length, 0, `${when}: no cross mark`);
}

function assertCancelledEnd(view, when, wording) {
  const text = endRowText(view);
  assert.match(text, wording, `${when}: the stop reads cancelled: ${text}`);
  assert.equal(view.status('.turn-status.interrupted').length, 1, `${when}: the cross mark`);
}

test('a turn the user’s message took over ends quietly with its card, live', async (t) => {
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool], busy: true, activityAt: 1_000 });
  await view.render({ items: [prompt, tool, liveEnd('message')], busy: true, activityAt: 869_000 });
  assertQuietEnd(view, 'the end written');
  await view.render({ items: [prompt, tool, liveEnd('message'), next], busy: true, activityAt: 869_500 });
  assertQuietEnd(view, 'the message’s turn runs');
  await view.render({ items: [prompt, tool, liveEnd('message'), next, reply, done], busy: false });
  assertQuietEnd(view, 'idle');
  assert.equal(view.cards(), 2, 'the taken-over turn keeps its card, as the finished one does');
  assertSteadyFrames(view.frames);
});

test('a turn the user’s message took over ends quietly with its card, read again', async (t) => {
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool, restoredEnd('message'), next, reply, done], busy: false });
  assertQuietEnd(view, 'read again');
  assert.equal(view.cards(), 2, 'read again, the card stays');
});

test('a turn the user stopped keeps its cancelled end and card, live', async (t) => {
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool], busy: true, activityAt: 1_000 });
  await view.render({ items: [prompt, tool, liveEnd()], busy: false });
  assertCancelledEnd(view, 'live', /Cancelled after 14m 28s/);
  assert.equal(view.cards(), 1, 'the stopped turn keeps its card');
  assertSteadyFrames(view.frames);
});

test('no working row is left after a stopped turn once the session is idle, whatever reply was still arriving', async (t) => {
  const tail = { kind: 'assistant', id: 'a1', text: 'Reading the file', streaming: true, at: 3_000 };
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool], busy: true, activityAt: 1_000, liveItem: tail });
  assert.equal(view.tags().at(-1), 'Thinking', 'the turn runs');
  // The stop is recorded and the session idles; the reply's tail was never cleared.
  await view.render({ items: [prompt, tool, liveEnd()], busy: false, liveItem: tail });
  assert.ok(!view.tags().includes('Thinking'), `idle with its end written: ${view.tags().join(' ')}`);
  assertCancelledEnd(view, 'idle', /Cancelled after 14m 28s/);
});

test('no working row is left once the session is idle with no end written and a reply’s tail left behind', async (t) => {
  const tail = { kind: 'assistant', id: 'a1', text: 'Reading the file', streaming: true, at: 3_000 };
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool], busy: true, activityAt: 1_000, liveItem: tail });
  await view.render({ items: [prompt, tool], busy: false, liveItem: tail });
  assert.ok(!view.tags().includes('Thinking'), `idle with no end: ${view.tags().join(' ')}`);
});

test('a reply still arriving when its turn’s end is written keeps the working row until it lands', async (t) => {
  const tail = { kind: 'assistant', id: 'a1', text: 'Done with', streaming: true, at: 3_000 };
  const named = { kind: 'turndone', id: 'd1', status: 'done', verb: 'Thought', finalAssistantId: 'a1', elapsedMs: 30_000, at: 3_100 };
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool], busy: true, activityAt: 1_000, liveItem: tail });
  await view.render({ items: [prompt, tool, named], busy: false, liveItem: tail });
  assert.equal(view.tags().at(-1), 'Thinking', 'the end names the reply: it is on its way');
  await view.render({ items: [prompt, tool, { ...tail, streaming: false, text: 'Done with it.' }, named], busy: false });
  assert.ok(!view.tags().includes('Thinking'));
});

test('a turn the user stopped while a message waited reads cancelled with its duration, read again', async (t) => {
  // The end is recorded on the turn's last row: no interruption marker stands for this stop.
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool, restoredEnd(), next, reply, done], busy: false });
  assertCancelledEnd(view, 'read again', /Cancelled after 14m 28s/);
});

test('a turn the user stopped with nothing queued reads cancelled from its marker, read again', async (t) => {
  const view = await mountTranscriptPane(t);
  await view.render({ items: [prompt, tool, markerEnd], busy: false });
  assertCancelledEnd(view, 'read again', /Cancelled/);
});
