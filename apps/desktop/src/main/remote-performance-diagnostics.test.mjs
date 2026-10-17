import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRemoteCallStats,
  createRemoteSocketDiagnostics,
  reportRemoteByteWindow,
  reportRemoteFirstTranscript,
} from './remote-performance-diagnostics.ts';

function socketDiagnosticsFixture(initial) {
  const state = { clients: initial.clients, buffered: initial.buffered ?? 0 };
  const lines = [];
  const timers = [];
  const probe = {
    calls: [],
    start() {
      this.calls.push('start');
    },
    stop() {
      this.calls.push('stop');
    },
    take() {
      this.calls.push('take');
      return { p50: 1, p99: 3.5, max: 20 };
    },
  };
  const diagnostics = createRemoteSocketDiagnostics({
    sample: () => ({ clients: state.clients, sockets: [{ name: 'relay', bufferedAmount: state.buffered }] }),
    write: (line) => lines.push(line),
    loopDelay: probe,
    setTimer: (tick, ms) => {
      const timer = { tick, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  return { state, lines, timers, probe, diagnostics };
}

test('routine remote performance reports use the info channel, never the error channel', () => {
  const info = [];
  let errors = 0;
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (message) => {
    info.push(String(message));
  };
  console.error = () => {
    errors += 1;
  };
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

test('capability calls are summarized per capability name', () => {
  let now = 0;
  const lines = [];
  const stats = createRemoteCallStats({ now: () => now, write: (line) => lines.push(line) });
  stats.record('invokeCapability:getTurnReviewDiff', 0, { requestBytes: 240, responseBytes: 180 });
  stats.record('invokeCapability:getTurnReviewDiff', 0, { requestBytes: 240, responseBytes: 180 });
  stats.record('readCapabilities:getTheme+getProfile', 1, { requestBytes: 200, responseBytes: 300 });
  stats.record('invokeCapability:not a name', 1);
  now = 60_000;
  stats.record('listProjects', 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /calls=5/);
  assert.match(lines[0], /invokeCapability:getTurnReviewDiff=2x\/0ms\/rx-box=480B\/tx-routed=360B/);
  assert.match(lines[0], /readCapabilities:getTheme\+getProfile=1x\/1ms/);
  assert.match(lines[0], / unknown=1x/);
});

test('a visit shorter than the window is still summarized when the last phone leaves', () => {
  let now = 0;
  const lines = [];
  const stats = createRemoteCallStats({ now: () => now, write: (line) => lines.push(line) });
  stats.clear();
  assert.equal(lines.length, 0, 'nothing recorded, nothing written');
  stats.record('statProjectFile', 2, { requestBytes: 100, responseBytes: 200 });
  now = 20_000;
  stats.clear();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[mixdog-remote-calls\] 20s calls=1 \| statProjectFile=1x/);
  stats.clear();
  assert.equal(lines.length, 1, 'a window is reported once');
});

test('socket diagnostics tick every 30s with the relay socket buffer and the loop delay', () => {
  const { state, lines, timers, probe, diagnostics } = socketDiagnosticsFixture({ clients: 1, buffered: 1536 });
  diagnostics.sync();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30_000);
  assert.deepEqual(probe.calls, ['start']);
  assert.equal(lines.length, 0, 'nothing is written before the first interval');
  timers[0].tick();
  state.buffered = 0;
  timers[0].tick();
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    '[mixdog-remote-sockets] 30s clients=1 buffered=relay:1.5KB loop-p50=1.0ms loop-p99=3.5ms loop-max=20.0ms'
  );
  assert.match(lines[1], /buffered=relay:0B /u);
});

test('socket diagnostics run only while a client is connected', () => {
  const { state, lines, timers, probe, diagnostics } = socketDiagnosticsFixture({ clients: 0 });
  diagnostics.sync();
  assert.equal(timers.length, 0, 'no client, no timer');
  assert.deepEqual(probe.calls, []);
  state.clients = 2;
  diagnostics.sync();
  diagnostics.sync();
  assert.equal(timers.length, 1, 'a second client does not start a second timer');
  timers[0].tick();
  assert.equal(lines.length, 1);
  state.clients = 0;
  diagnostics.sync();
  assert.equal(timers[0].cleared, true);
  assert.equal(probe.calls.at(-1), 'stop');
  assert.equal(lines.length, 1);
  state.clients = 1;
  diagnostics.sync();
  assert.equal(timers.length, 2, 'the next client starts a fresh window');
});

test('a tick that finds no client stops itself instead of logging', () => {
  const { state, lines, timers, diagnostics } = socketDiagnosticsFixture({ clients: 1 });
  diagnostics.sync();
  state.clients = 0;
  timers[0].tick();
  assert.equal(lines.length, 0);
  assert.equal(timers[0].cleared, true);
  diagnostics.stop();
});
