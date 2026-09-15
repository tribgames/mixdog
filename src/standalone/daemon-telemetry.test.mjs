import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DAEMON_TELEMETRY_INTERVAL_MS,
  collectDaemonTelemetry,
  createDaemonTelemetry,
  formatDaemonTelemetry,
} from './daemon-telemetry.mjs';

const TELEMETRY_URL = new URL('./daemon-telemetry.mjs', import.meta.url).href;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const MB = 1024 * 1024;

function fixture(overrides = {}) {
  const lines = [];
  const timers = [];
  const intervalTicks = [];
  const telemetry = createDaemonTelemetry({
    log: (line) => lines.push(line),
    getWork: () => ({
      activeCalls: 1,
      queuedCalls: 2,
      busySessions: 3,
      busyMemoryAgents: 4,
    }),
    onInterval() { intervalTicks.push('lag'); },
    now: () => new Date('2026-04-08T12:34:56.000Z'),
    pid: 12156,
    memoryUsage: () => ({
      rss: 747 * MB,
      heapUsed: 630 * MB,
      heapTotal: 700 * MB,
      external: 5 * MB,
      arrayBuffers: 6 * MB,
    }),
    heapStatistics: () => ({ heap_size_limit: 768 * MB }),
    setIntervalFn(fn, ms) {
      const timer = { fn, ms, unrefed: false, cleared: false, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { timer.cleared = true; },
    ...overrides,
  });
  return { telemetry, lines, timers, intervalTicks };
}

function runNode(args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`timed out: ${stderr || stdout}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, pid: child.pid });
    });
  });
}

test('boot and periodic lines carry timestamp, pid, memory, V8 limit, and inFlightWork counts', () => {
  const { telemetry, lines } = fixture();
  const boot = telemetry.emit('boot');
  telemetry.emit('periodic');

  assert.equal(boot.ts, '2026-04-08T12:34:56.000Z');
  assert.equal(boot.pid, 12156);
  assert.equal(boot.rssBytes, 747 * MB);
  assert.equal(boot.heapUsedBytes, 630 * MB);
  assert.equal(boot.heapTotalBytes, 700 * MB);
  assert.equal(boot.heapLimitBytes, 768 * MB);
  assert.equal(boot.externalBytes, 5 * MB);
  assert.equal(boot.arrayBufferBytes, 6 * MB);
  assert.equal(boot.activeCalls, 1);
  assert.equal(boot.queuedCalls, 2);
  assert.equal(boot.busySessions, 3);
  assert.equal(boot.busyMemoryAgents, 4);

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^daemon-telemetry reason=boot ts=2026-04-08T12:34:56.000Z pid=12156 /);
  assert.match(lines[1], /^daemon-telemetry reason=periodic /);
  for (const line of lines) {
    assert.match(line, /rssBytes=783286272/);
    assert.match(line, /heapUsedBytes=660602880/);
    assert.match(line, /heapTotalBytes=734003200/);
    assert.match(line, /heapLimitBytes=805306368/);
    assert.match(line, /externalBytes=5242880/);
    assert.match(line, /arrayBufferBytes=6291456/);
    assert.match(line, /activeCalls=1 queuedCalls=2 busySessions=3 busyMemoryAgents=4$/);
    assert.ok(line.length < 1024);
  }
});

test('the heap limit is the process V8 ceiling, not host free RAM', () => {
  const freeMemoryBytes = 16 * 1024 * 1024 * 1024;
  const record = collectDaemonTelemetry({
    pid: 12156,
    now: () => new Date('2026-04-08T00:00:00.000Z'),
    memoryUsage: () => ({
      rss: 100 * MB,
      heapUsed: 40 * MB,
      heapTotal: 80 * MB,
      external: 1,
      arrayBuffers: 2,
    }),
    heapStatistics: () => ({ heap_size_limit: 768 * MB }),
    work: { activeCalls: 0, queuedCalls: 0, busySessions: 0, busyMemoryAgents: 0, freeMemoryBytes },
  });
  assert.equal(record.heapLimitBytes, 768 * MB);
  assert.notEqual(record.heapLimitBytes, freeMemoryBytes);
  assert.equal('freeMemoryBytes' in record, false);
  assert.equal('systemMemory' in record, false);
  const line = formatDaemonTelemetry(record, 'boot');
  assert.equal(line.includes(String(freeMemoryBytes)), false);
  assert.match(line, /heapLimitBytes=805306368/);
});

test('session bodies, tokens, and env never enter the record or log line', () => {
  const record = collectDaemonTelemetry({
    now: () => new Date('2026-04-08T00:00:00.000Z'),
    pid: 7,
    memoryUsage: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5 }),
    heapStatistics: () => ({ heap_size_limit: 6 }),
    work: {
      activeCalls: 9,
      queuedCalls: 8,
      busySessions: 7,
      busyMemoryAgents: 6,
      sessionBody: 'SECRET_TRANSCRIPT',
      token: 'sekrit-token',
      env: { OPENAI_API_KEY: 'sk-test', MIXDOG_HOME: tmpdir() },
    },
  });
  const line = formatDaemonTelemetry(record, 'boot');
  assert.deepEqual(Object.keys(record), [
    'ts', 'pid', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'heapLimitBytes',
    'externalBytes', 'arrayBufferBytes', 'activeCalls', 'queuedCalls',
    'busySessions', 'busyMemoryAgents',
  ]);
  assert.equal(line.includes('SECRET_TRANSCRIPT'), false);
  assert.equal(line.includes('sekrit-token'), false);
  assert.equal(line.includes('OPENAI_API_KEY'), false);
  assert.equal(line.includes('sk-test'), false);
  assert.equal(line.includes('MIXDOG_HOME'), false);
  assert.equal(line.includes(tmpdir()), false);
  assert.match(line, /activeCalls=9 queuedCalls=8 busySessions=7 busyMemoryAgents=6$/);
});

test('the production timer is a single 30s unrefed loop that samples then runs onInterval, and stop clears it', () => {
  assert.equal(DAEMON_TELEMETRY_INTERVAL_MS, 30_000);
  assert.ok(DAEMON_TELEMETRY_INTERVAL_MS < TEN_MINUTES_MS);

  const { telemetry, lines, timers, intervalTicks } = fixture();
  telemetry.emit('boot');
  const first = telemetry.start();
  const second = telemetry.start(1_000);
  assert.equal(second, first);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, DAEMON_TELEMETRY_INTERVAL_MS);
  assert.equal(timers[0].unrefed, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^daemon-telemetry reason=boot /);
  assert.equal(intervalTicks.length, 0);

  timers[0].fn();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^daemon-telemetry reason=periodic /);
  assert.deepEqual(intervalTicks, ['lag']);

  telemetry.stop();
  telemetry.stop();
  assert.equal(timers[0].cleared, true);
  timers[0].fn();
  assert.equal(lines.length, 2);
  assert.deepEqual(intervalTicks, ['lag']);
});

test('a getWork failure still emits memory fields and does not throw into the timer', () => {
  const { telemetry, lines } = fixture({
    getWork: () => { throw new Error('session body leaked'); },
  });
  const record = telemetry.emit('boot');
  assert.equal(record.rssBytes, 747 * MB);
  assert.equal(record.activeCalls, 0);
  assert.equal(record.queuedCalls, 0);
  assert.equal(record.busySessions, 0);
  assert.equal(record.busyMemoryAgents, 0);
  assert.equal(lines.join('').includes('session body leaked'), false);
});

test('separate processes report that process V8 heap_size_limit, not host free RAM', async () => {
  const script = `
    import os from 'node:os';
    import v8 from 'node:v8';
    import { collectDaemonTelemetry } from ${JSON.stringify(TELEMETRY_URL)};
    const row = collectDaemonTelemetry({ work: { activeCalls: 0, queuedCalls: 0, busySessions: 0, busyMemoryAgents: 0 } });
    process.stdout.write(JSON.stringify({
      pid: row.pid,
      heapLimitBytes: row.heapLimitBytes,
      v8HeapSizeLimit: v8.getHeapStatistics().heap_size_limit,
      freeMemoryBytes: os.freemem(),
    }));
  `;
  const [small, large] = await Promise.all([
    runNode([`--max-old-space-size=96`, '--input-type=module', '-e', script]),
    runNode([`--max-old-space-size=192`, '--input-type=module', '-e', script]),
  ]);
  assert.equal(small.code, 0, small.stderr);
  assert.equal(large.code, 0, large.stderr);
  const smallRow = JSON.parse(small.stdout);
  const largeRow = JSON.parse(large.stdout);
  assert.equal(smallRow.pid, small.pid);
  assert.equal(largeRow.pid, large.pid);
  assert.notEqual(smallRow.pid, process.pid);
  assert.equal(smallRow.heapLimitBytes, smallRow.v8HeapSizeLimit);
  assert.equal(largeRow.heapLimitBytes, largeRow.v8HeapSizeLimit);
  assert.ok(smallRow.heapLimitBytes < largeRow.heapLimitBytes);
  assert.notEqual(smallRow.heapLimitBytes, smallRow.freeMemoryBytes);
  assert.notEqual(largeRow.heapLimitBytes, largeRow.freeMemoryBytes);
});

test('an unrefed telemetry timer does not keep a child process alive', async () => {
  const script = `
    import { createDaemonTelemetry } from ${JSON.stringify(TELEMETRY_URL)};
    const telemetry = createDaemonTelemetry({ log() {}, getWork: () => ({}) });
    telemetry.start(60_000);
  `;
  const child = await runNode(['--input-type=module', '-e', script], { timeoutMs: 8_000 });
  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.signal, null);
});

test('a child using the production start/stop loop emits periodic samples then freezes after stop', async () => {
  const script = `
    import { createDaemonTelemetry } from ${JSON.stringify(TELEMETRY_URL)};
    const lines = [];
    let intervalTicks = 0;
    const telemetry = createDaemonTelemetry({
      log: (line) => lines.push(line),
      getWork: () => ({ activeCalls: 1, queuedCalls: 0, busySessions: 0, busyMemoryAgents: 0 }),
      onInterval() { intervalTicks += 1; },
    });
    telemetry.emit('boot');
    telemetry.start(50);
    await new Promise((resolve) => setTimeout(resolve, 180));
    telemetry.stop();
    const frozen = { lines: lines.length, intervalTicks };
    await new Promise((resolve) => setTimeout(resolve, 180));
    process.stdout.write(JSON.stringify({
      boot: lines[0] || '',
      frozen,
      after: { lines: lines.length, intervalTicks },
      periodic: lines.filter((line) => line.includes('reason=periodic')).length,
    }));
  `;
  const child = await runNode(['--input-type=module', '-e', script], { timeoutMs: 8_000 });
  assert.equal(child.code, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.match(report.boot, /^daemon-telemetry reason=boot /);
  assert.ok(report.frozen.intervalTicks >= 1);
  assert.ok(report.periodic >= 1);
  assert.equal(report.after.lines, report.frozen.lines);
  assert.equal(report.after.intervalTicks, report.frozen.intervalTicks);
});
