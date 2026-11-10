import test from 'node:test';
import assert from 'node:assert/strict';
import { packCycle1Windows } from './memory-cycle1.mjs';
import { periodicCycleDue } from './cycle-scheduler.mjs';

test('cycle1 packets cap each agent at 50 rows and each cycle at four agents', () => {
  const rowsBySession = new Map([
    ['a', Array.from({ length: 130 }, (_, i) => ({ id: 130 - i }))],
    ['b', Array.from({ length: 130 }, (_, i) => ({ id: 260 - i }))],
  ]);
  const packets = packCycle1Windows(rowsBySession, 100, 10);
  assert.equal(packets.length, 4);
  assert.ok(packets.every((packet) => packet.length <= 50));
  assert.equal(
    packets.reduce((sum, packet) => sum + packet.length, 0),
    200
  );
});

test('cycle1 reserves a packet for the oldest selected session and round-robins busy sessions', () => {
  const sessions = new Map(
    Array.from({ length: 10 }, (_, s) => [
      String(s),
      Array.from({ length: 120 }, (_, i) => ({ id: s * 1000 + 120 - i, session_id: String(s) })),
    ])
  );
  const packets = packCycle1Windows(sessions);
  assert.deepEqual(
    packets.map((packet) => packet[0].session_id),
    ['0', '1', '2', '9']
  );
  assert.equal(new Set(packets.flat().map((row) => row.id)).size, 200);
});

test('a never-run periodic cycle gets one startup interval of grace', () => {
  const startedAt = 1_000_000;
  assert.equal(periodicCycleDue(0, startedAt, 600_000, startedAt + 599_999), false);
  assert.equal(periodicCycleDue(0, startedAt, 600_000, startedAt + 600_000), true);
});

test('an overdue periodic cycle stays due across a runtime restart', () => {
  const lastSuccess = 1_000_000;
  const restartedAt = 2_000_000;
  assert.equal(periodicCycleDue(lastSuccess, restartedAt, 600_000, restartedAt), true);
});
