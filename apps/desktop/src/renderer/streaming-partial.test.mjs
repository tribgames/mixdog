/**
 * streaming-partial.test.mjs — the live row joins the line-gated tail with
 * the engine's unfinished line, on every renderer lane.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { streamingTailWithPartial, withStreamingPartial } from '../shared/streaming-partial.ts';
import { createTranscriptSnapshotDecorator } from './snapshot-transcript-decoration.ts';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder, markCompactWire } from '../main/state-delta.ts';

test('a long unfinished line crosses the desktop hops in bytes linear in its length', () => {
  for (const compact of [false, true]) {
    const encoder = createSnapshotDeltaEncoder({ compact, partialAppend: true });
    const legacy = createSnapshotDeltaEncoder({ compact });
    const decoder = createSnapshotDeltaDecoder();
    const send = (snapshot) => {
      const wire = encoder.encode(snapshot);
      if (compact && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
      const result = decoder.decode(wire);
      assert.equal(result.ok, true);
      return { bytes: JSON.stringify(wire).length, snapshot: result.snapshot };
    };
    const state = (streamingPartial) => ({
      sessionId: 's',
      items,
      streamingTail: tail('head\n'),
      streamingPartial,
    });
    send(state({ id: 'a1', from: 5, text: 'x' }));
    legacy.encode(state({ id: 'a1', from: 5, text: 'x' }));
    let text = 'x';
    let bytes = 0;
    let legacyBytes = 0;
    let received;
    for (let step = 0; step < 1_000; step += 1) {
      text += 'y'.repeat(100);
      const sent = send(state({ id: 'a1', from: 5, text }));
      bytes += sent.bytes;
      received = sent.snapshot;
      legacyBytes += JSON.stringify(legacy.encode(state({ id: 'a1', from: 5, text }))).length;
    }
    assert.equal(received.streamingPartial.text, text);
    // Linear: the text once plus a bounded envelope per frame (v1 frames
    // repeat their revision bookkeeping); a whole-line resend is ~50 MB.
    assert.ok(bytes < text.length + 300 * 1_000, `${bytes} bytes for a ${text.length}-char line`);
    // An encoder for a peer that did not announce it still sends whole lines.
    assert.ok(legacyBytes > 100 * text.length);
    // A retraction travels whole and replaces the held line.
    const retracted = send(state({ id: 'a1', from: 5, text: 'xy' }));
    assert.deepEqual(retracted.snapshot.streamingPartial, { id: 'a1', from: 5, text: 'xy' });
  }
});

test('a partial append without a held partial asks for a resync', () => {
  const decoder = createSnapshotDeltaDecoder();
  assert.equal(decoder.decode({ sessionId: 's', items, __itemsRevision: 1 }).ok, true);
  const wire = { r: 2, pa: 'tail' };
  markCompactWire(wire);
  assert.equal(decoder.decode(wire).ok, false);
});

const items = [{ id: 'u1', kind: 'user', text: 'question' }];
const tail = (text) => ({ id: 'a1', kind: 'assistant', text, streaming: true, at: 5 });

test('the renderer lane prefers the partial line over the line-gated tail', () => {
  const decorator = createTranscriptSnapshotDecorator({ register: false });
  const snapshot = decorator.decorate({
    sessionId: 's',
    items,
    streamingTail: tail('first line\n'),
    streamingPartial: { id: 'a1', from: 11, text: 'second li' },
  });
  assert.equal(snapshot.streamingTail.text, 'first line\nsecond li');
  assert.equal(snapshot.streamingTail.id, 'a1');
  assert.equal(snapshot.streamingTail.at, 5);
  // Without a partial the lane paints the line-gated tail exactly as before.
  const plain = decorator.decorate({ sessionId: 's', items, streamingTail: tail('first line\nsecond line\n') });
  assert.equal(plain.streamingTail.text, 'first line\nsecond line\n');
});

test('before the first completed line the partial opens the row with its final identity', () => {
  const state = {
    items,
    streamingTail: null,
    streamingPartial: {
      id: 'a1',
      from: 0,
      text: 'Hel',
      tail: { kind: 'assistant', id: 'a1', streaming: true, at: 5, messageId: 'm1', model: 'x' },
    },
  };
  const row = streamingTailWithPartial(state);
  assert.deepEqual(row, {
    kind: 'assistant',
    id: 'a1',
    streaming: true,
    at: 5,
    messageId: 'm1',
    model: 'x',
    text: 'Hel',
  });
  // The same partial and tail objects join to the same row object.
  assert.equal(streamingTailWithPartial(state), row);
  // A row that already settled is never reopened.
  const settled = { ...state, items: [...items, { id: 'a1', kind: 'assistant', text: 'Hello' }] };
  assert.equal(streamingTailWithPartial(settled), null);
  // Whitespace alone opens no row.
  assert.equal(
    streamingTailWithPartial({ ...state, streamingPartial: { ...state.streamingPartial, text: '\n ' } }),
    null
  );
});

test('a partial for another row or a stale offset leaves the tail untouched', () => {
  const base = { items, streamingTail: tail('one\n') };
  for (const streamingPartial of [
    { id: 'other', from: 4, text: 'x' },
    { id: 'a1', from: 2, text: 'x' },
    { id: 'a1', from: 4, text: '' },
    null,
    'garbage',
  ]) {
    const state = { ...base, streamingPartial };
    assert.equal(withStreamingPartial(state), state);
  }
});
