import assert from 'node:assert/strict';
import test from 'node:test';

import { collectSockets, formatSocketReport, startSocketDiagnostics } from './relay-diagnostics.mjs';

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (tick, ms) => {
      const timer = { tick, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  };
}

function fakeProbe() {
  const calls = [];
  return {
    calls,
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    take: () => {
      calls.push('take');
      return { p50: 1, p99: 4.25, max: 12 };
    },
  };
}

function desktops(phoneBuffers, desktopBuffered = 0) {
  const clients = new Map(phoneBuffers.map((bufferedAmount, index) => [`phone-${index}-xxxxxxxx`, { bufferedAmount }]));
  return new Map([
    ['desktop-id-1', { socket: { bufferedAmount: desktopBuffered }, clients }],
    ['idle-desktop', { socket: { bufferedAmount: 99 }, clients: new Map() }],
  ]);
}

const tickN = (timer, count) => {
  for (let index = 0; index < count; index += 1) timer.tick();
};

test('logs every interval while a phone is connected, with each socket buffer and the loop delay', () => {
  const live = desktops([0, 2048], 10);
  const lines = [];
  const timing = fakeTimers();
  const probe = fakeProbe();
  startSocketDiagnostics({ liveDesktops: live, write: (line) => lines.push(line), loopDelay: probe, ...timing });
  assert.equal(timing.timers.length, 1);
  assert.equal(timing.timers[0].ms, 5_000, 'a cheap watch tick, six of which make one 30s report');
  tickN(timing.timers[0], 5);
  assert.equal(lines.length, 0, 'nothing is written before the first interval');
  tickN(timing.timers[0], 1);
  assert.equal(lines.length, 1);
  tickN(timing.timers[0], 6);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[relay\] sockets 30s phones=2 buffered /u);
  assert.match(lines[0], /phone:phone-1-=2\.0KB/u);
  assert.match(lines[0], /desktop:desktop-=10B/u);
  assert.match(lines[0], /loop-p50=1\.0ms loop-p99=4\.3ms loop-max=12\.0ms$/u);
  assert.doesNotMatch(lines[0], /idle-des/u, 'a desktop with no phone is not listed');
});

test('the event-loop sampler runs only while a PC or phone is connected', () => {
  const live = new Map();
  const lines = [];
  const timing = fakeTimers();
  const probe = fakeProbe();
  const diagnostics = startSocketDiagnostics({
    liveDesktops: live,
    write: (line) => lines.push(line),
    loopDelay: probe,
    ...timing,
  });
  assert.deepEqual(probe.calls, [], 'an idle relay starts no sampler');
  tickN(timing.timers[0], 20);
  assert.deepEqual(probe.calls, []);
  // A desktop alone is a connection: sampled, but nothing is logged without a phone.
  live.set('desktop-id-1', { socket: { bufferedAmount: 0 }, clients: new Map() });
  tickN(timing.timers[0], 6);
  assert.deepEqual(probe.calls, ['start', 'take']);
  assert.deepEqual(lines, []);
  live.get('desktop-id-1').clients.set('late-phone', { bufferedAmount: 5 });
  tickN(timing.timers[0], 6);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /phones=1 /u);
  // The last connection leaves: the sampler stops at the next watch tick.
  live.clear();
  timing.timers[0].tick();
  assert.equal(probe.calls.at(-1), 'stop');
  const stopped = probe.calls.length;
  tickN(timing.timers[0], 20);
  assert.equal(probe.calls.length, stopped);
  // And starts again for the next one.
  live.set('desktop-id-2', { socket: {}, clients: new Map() });
  timing.timers[0].tick();
  assert.equal(probe.calls.at(-1), 'start');
  diagnostics.stop();
  assert.equal(probe.calls.at(-1), 'stop');
});

test('stop clears the timer and the probe', () => {
  const timing = fakeTimers();
  const probe = fakeProbe();
  const diagnostics = startSocketDiagnostics({
    liveDesktops: desktops([0]),
    write: () => {},
    loopDelay: probe,
    ...timing,
  });
  timing.timers[0].tick();
  diagnostics.stop();
  assert.equal(timing.timers[0].cleared, true);
  assert.equal(probe.calls.at(-1), 'stop');
});

test('a long socket list names the largest and sums the rest', () => {
  const buffers = Array.from({ length: 20 }, (_, index) => index * 100);
  const { phones, sockets } = collectSockets(desktops(buffers));
  assert.equal(phones, 20);
  const line = formatSocketReport({ phones, sockets, loop: { p50: 0, p99: 0, max: 0 }, intervalMs: 30_000 });
  assert.match(line, /\+9 more=/u);
  assert.equal(line.split(' ').filter((part) => part.startsWith('phone:')).length, 12);
  assert.match(line, /phone:phone-19=1\.9KB/u);
});
