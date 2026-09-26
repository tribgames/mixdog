import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteByteMeter, formatRemoteByteReport } from './remote-performance.ts';

test('a short visit reports its partial window once when cleared', () => {
  let now = 0;
  const meter = createRemoteByteMeter({ enabled: true, now: () => now });
  assert.equal(meter.clear(), null);
  meter.record({ id: 1 }, 300);
  now = 15_000;
  const report = meter.clear();
  assert.equal(report.bytes, 300);
  assert.equal(report.windowMs, 15_000);
  assert.equal(meter.clear(), null);
});

test('byte windows start with traffic and a disconnected client leaves no stale idle window', () => {
  let now = 0;
  const meter = createRemoteByteMeter({ enabled: true, now: () => now });
  now = 1_000_000;
  assert.equal(meter.record({ id: 1 }, 100), null);
  now += 60_000;
  const report = meter.record({ id: 2 }, 200);
  assert.equal(report.windowMs, 60_000);
  assert.equal(report.bytes, 300);
  assert.equal(report.frames, 2);
  assert.match(formatRemoteByteReport(report), /direction=desktop-to-relay unit=ws-message/);
  meter.clear();
  now += 10_000_000;
  assert.equal(meter.record({ event: 'sessions' }, 10), null);
  now += 60_000;
  assert.equal(meter.record({ event: 'sessions' }, 20).bytes, 30);
});
