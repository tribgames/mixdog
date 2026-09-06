import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteStateLane } from './remote-state-lane.ts';
import { createSnapshotDeltaDecoder, markCompactWire } from './state-delta.ts';

test('one receiver resyncs in full while its sibling continues a valid compact delta stream', async () => {
  const received = [[], []];
  const decoders = [createSnapshotDeltaDecoder(), createSnapshotDeltaDecoder()];
  const lanes = received.map((frames, index) => createRemoteStateLane(true, async (frame, droppable) => {
    const wire = frame.w;
    if (!Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
    const decoded = decoders[index].decode(wire);
    assert.equal(decoded.ok, true);
    frames.push({ snapshot: decoded.snapshot, droppable, bytes: JSON.stringify(frame).length });
  }));
  const initial = {
    sessionId: 'session', items: [{ id: 1, text: 'x'.repeat(10000) }],
    status: 'idle', streamingTail: null,
  };
  lanes.forEach((lane) => lane.reset(initial));
  await new Promise(setImmediate);
  lanes[0].reset(initial);
  await new Promise(setImmediate);
  assert.equal(received[0].length, 2);
  assert.equal(received[1].length, 1);
  const next = { ...initial, status: 'running' };
  lanes.forEach((lane) => lane.publish(next));
  await new Promise(setImmediate);
  assert.deepEqual(received[1].at(-1).snapshot, next);
  assert.equal(received[0][1].droppable, false);
  assert.equal(received[1].at(-1).droppable, true);
  assert.ok(received[1].at(-1).bytes < 500);
});
