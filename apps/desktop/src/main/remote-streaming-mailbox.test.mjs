import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteStreamingMailbox, REMOTE_STREAM_BATCH_MS } from './remote-streaming-mailbox.ts';
import { createSnapshotDeltaEncoder, createSnapshotDeltaDecoder, markCompactWire } from './state-delta.ts';

function clock() {
  let now = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout(callback, ms) { const id = { unref() {} }; pending.set(id, { callback, at: now + ms }); return id; },
      clearTimeout(id) { pending.delete(id); },
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at > now) continue;
        pending.delete(id); entry.callback();
      }
    },
    get pending() { return pending.size; },
  };
}
const items = [{ id: 'user', kind: 'user', text: 'input' }];
const update = (text, fields = {}) => ({
  sessionId: 's', frameSource: 'live',
  snapshot: { busy: true, items, streamingTail: { id: 'tail', kind: 'assistant', text }, ...fields },
});

test('a text burst sends one latest snapshot within 16ms, with every character preserved', () => {
  const time = clock();
  const frames = [];
  let mailbox;
  mailbox = createRemoteStreamingMailbox((sequence, value, critical) => {
    frames.push({ value, critical }); mailbox.acknowledge(sequence);
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
    frames.push({ value, critical }); mailbox.acknowledge(sequence);
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

test('batching reduces real compact packet bytes while preserving decoder state', () => {
  const time = clock();
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const decoder = createSnapshotDeltaDecoder();
  let bytes = 0, packets = 0, received;
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
