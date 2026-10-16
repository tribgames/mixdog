import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteStreamingMailbox, REMOTE_STREAM_BATCH_MS } from './remote-streaming-mailbox.ts';
import { createSnapshotDeltaEncoder, createSnapshotDeltaDecoder, markCompactWire } from './state-delta.ts';
import { streamingPartialSuffix as desktopSuffix } from '../shared/streaming-partial.ts';
import { streamingPartialSuffix as daemonSuffix } from '../../../../src/standalone/session-state-patch.mjs';

test('the desktop and daemon partial-append suffix checks agree on every input', () => {
  const line = { id: 'a', from: 3, text: 'abc' };
  const cases = [
    [line, { ...line, text: 'abcde' }],
    [line, { ...line, text: 'abc' }],
    [line, { ...line, text: 'ab' }],
    [line, { ...line, text: 'xbcde' }],
    [line, { ...line, from: 4, text: 'abcde' }],
    [line, { ...line, id: 'b', text: 'abcde' }],
    [line, { ...line, tail: { id: 'a' }, text: 'abcde' }],
    [{ ...line, text: '' }, { ...line, text: 'x' }],
    [line, { id: 'a', from: 3, text: 7 }],
    [null, line],
    [line, undefined],
    ['abc', 'abcd'],
    [[], []],
  ];
  for (const [before, after] of cases) assert.equal(desktopSuffix(before, after), daemonSuffix(before, after));
  assert.equal(desktopSuffix(line, cases[0][1]), 'de');
});

function clock() {
  let now = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout(callback, ms) {
        const id = { unref() {} };
        pending.set(id, { callback, at: now + ms });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(id);
        entry.callback();
      }
    },
    get pending() {
      return pending.size;
    },
  };
}
const items = [{ id: 'user', kind: 'user', text: 'input' }];
const update = (text, fields = {}) => ({
  sessionId: 's',
  frameSource: 'live',
  snapshot: { busy: true, items, streamingTail: { id: 'tail', kind: 'assistant', text }, ...fields },
});

test('a text burst sends one latest snapshot within 16ms, with every character preserved', () => {
  const time = clock();
  const frames = [];
  let mailbox;
  mailbox = createRemoteStreamingMailbox((sequence, value, critical) => {
    frames.push({ value, critical });
    mailbox.acknowledge(sequence);
  }, time.timers);
  mailbox.publish(update(''));
  mailbox.publish(update('한'));
  mailbox.publish(update('한글'));
  assert.equal(frames.length, 1);
  assert.equal(time.pending, 1);
  time.advance(REMOTE_STREAM_BATCH_MS - 1);
  assert.equal(frames.length, 1);
  time.advance(1);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].value.snapshot.streamingTail.text, '한글');
  assert.equal(frames[1].critical, false);
});

test('completion, replay, and unknown approval fields bypass batching and remain critical', () => {
  const time = clock();
  const frames = [];
  let mailbox;
  mailbox = createRemoteStreamingMailbox((sequence, value, critical) => {
    frames.push({ value, critical });
    mailbox.acknowledge(sequence);
  }, time.timers);
  mailbox.publish(update(''));
  mailbox.publish(update('pending text'));
  mailbox.publish(update('pending text', { futureApproval: { id: 'approval' } }));
  assert.equal(frames.length, 2);
  assert.equal(frames[1].critical, true);
  assert.equal(time.pending, 0);
  mailbox.publish(update('complete', { busy: false }));
  assert.equal(frames.at(-1).value.snapshot.busy, false);
  assert.equal(frames.at(-1).critical, true);
  mailbox.publish({ ...update('replay'), frameSource: 'replay' });
  assert.equal(frames.at(-1).value.frameSource, 'replay');
  assert.equal(frames.at(-1).critical, true);
});

test('backpressure cannot downgrade queued approval state and disconnect clears delayed work', () => {
  const time = clock();
  const frames = [];
  const mailbox = createRemoteStreamingMailbox((sequence, value, critical) => {
    frames.push({ sequence, value, critical });
  }, time.timers);
  const approval = { id: 'approval' };
  mailbox.publish(update(''));
  mailbox.publish(update('', { futureApproval: approval }));
  mailbox.publish(update('continued', { futureApproval: approval }));
  time.advance(REMOTE_STREAM_BATCH_MS);
  assert.equal(frames.length, 1);
  mailbox.acknowledge(frames[0].sequence);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].value.snapshot.futureApproval, approval);
  assert.equal(frames[1].value.snapshot.streamingTail.text, 'continued');
  assert.equal(frames[1].critical, true);
  mailbox.publish(update('continued text', { futureApproval: approval }));
  mailbox.clear();
  time.advance(100);
  mailbox.acknowledge(frames[1].sequence);
  assert.equal(frames.length, 2);
});

test('partial-line growth batches as a text append; a partial for another row does not', () => {
  const time = clock();
  const frames = [];
  let mailbox;
  mailbox = createRemoteStreamingMailbox((sequence, value, critical) => {
    frames.push({ value, critical });
    mailbox.acknowledge(sequence);
  }, time.timers);
  const partial = (text, from = 6, id = 'tail') => ({ streamingPartial: { id, from, text } });
  mailbox.publish(update('line1\n'));
  mailbox.publish(update('line1\n', partial('pa')));
  mailbox.publish(update('line1\n', partial('partial')));
  // The completed line moves the tail and restarts the partial after it.
  mailbox.publish(update('line1\npartial line\n', partial('ne', 19)));
  assert.equal(frames.length, 1);
  time.advance(REMOTE_STREAM_BATCH_MS);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].critical, false);
  assert.deepEqual(frames[1].value.snapshot.streamingPartial, { id: 'tail', from: 19, text: 'ne' });
  mailbox.publish(update('line1\npartial line\n', partial('x', 0, 'other')));
  assert.equal(frames.length, 3);
  assert.equal(frames[2].critical, true);
});

test('a decoder that predates streamingPartial keeps painting the line-gated tail', () => {
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const decoder = createSnapshotDeltaDecoder();
  const send = (snapshot) => {
    const wire = encoder.encode(snapshot);
    if (!Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
    const result = decoder.decode(wire);
    assert.equal(result.ok, true);
    return result.snapshot;
  };
  const tail = (text) => ({ id: 'tail', kind: 'assistant', text, streaming: true });
  send({ busy: true, items, streamingTail: tail('one\n') });
  const received = send({
    busy: true,
    items,
    streamingTail: tail('one\n'),
    streamingPartial: { id: 'tail', from: 4, text: 'tw' },
  });
  // The field travels as plain state; the tail itself is untouched.
  assert.equal(received.streamingTail.text, 'one\n');
  assert.deepEqual(received.streamingPartial, { id: 'tail', from: 4, text: 'tw' });
  const settled = send({
    busy: false,
    items: [...items, { ...tail('one\ntwo'), streaming: false }],
    streamingTail: null,
  });
  assert.equal(Object.hasOwn(settled, 'streamingPartial'), false);
});

test('batching reduces real compact packet bytes while preserving decoder state', () => {
  const time = clock();
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const decoder = createSnapshotDeltaDecoder();
  let bytes = 0,
    packets = 0,
    received;
  let mailbox;
  mailbox = createRemoteStreamingMailbox((sequence, value) => {
    const wire = encoder.encode(value.snapshot);
    if (packets > 0) bytes += Buffer.byteLength(JSON.stringify({ e: 'T', s: 1, w: wire })) + 82;
    packets += 1;
    if (!Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
    const result = decoder.decode(wire);
    assert.equal(result.ok, true);
    received = result.snapshot;
    mailbox.acknowledge(sequence);
  }, time.timers);
  mailbox.publish(update(''));
  let text = '';
  for (let i = 0; i < 100; i += 1) {
    text += '응답 ';
    mailbox.publish(update(text));
    time.advance(4);
  }
  time.advance(16);
  assert.equal(received.streamingTail.text, text);
  assert.equal(packets, 26); // initial state + 25 text groups
  assert.ok(bytes < 5000, `unexpected burst cost: ${bytes}`);
});
