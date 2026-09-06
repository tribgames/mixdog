import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRemoteCallStats,
  reportRemoteByteWindow,
  reportRemoteFirstTranscript,
} from './remote-performance-diagnostics.ts';

test('routine remote performance reports use the info channel, never the error channel', () => {
  const info = [];
  let errors = 0;
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (message) => { info.push(String(message)); };
  console.error = () => { errors += 1; };
  try {
    reportRemoteByteWindow({
      windowMs: 60_000,
      frames: 2,
      bytes: 2048,
      lanes: [{ lane: 'rpc', frames: 2, bytes: 2048 }],
    });
    reportRemoteFirstTranscript(1250, 3072);
    let now = 0;
    const calls = createRemoteCallStats({ now: () => now });
    calls.record('getSessions', 10);
    now = 60_000;
    calls.record('getSessions', 15);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  assert.equal(errors, 0);
  assert.equal(info.length, 3);
  assert.match(info[0], /^\[mixdog-remote-meter\]/u);
  assert.match(info[1], /^\[mixdog-remote-first-transcript\] ms=1250 payload=3KB$/u);
  assert.match(info[2], /^\[mixdog-remote-calls\] 60s calls=2/u);
});

test('RPC diagnostics attribute actual byte counts without retaining request or response bodies', () => {
  let now = 100_000;
  const lines = [];
  const stats = createRemoteCallStats({ now: () => now, write: (line) => lines.push(line) });
  now = 900_000; // idle before the first call is not an active report window
  stats.record('listProjects', 2, { requestBytes: 80, responseBytes: 1200 });
  assert.equal(lines.length, 0);
  now += 60_000;
  stats.record('getSnapshot', 3, { requestBytes: 90, responseBytes: 2400 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /60s calls=2/);
  assert.match(lines[0], /getSnapshot=1x\/3ms\/rx-box=90B\/tx-routed=2400B/);
  assert.match(lines[0], /listProjects=1x\/2ms\/rx-box=80B\/tx-routed=1200B/);
  stats.clear();
  now += 10_000_000;
  stats.record('getSnapshot', 1);
  assert.equal(lines.length, 1);
});
