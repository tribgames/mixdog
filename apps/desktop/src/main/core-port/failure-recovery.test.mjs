import assert from 'node:assert/strict';
import test from 'node:test';

import { BootReports } from './boot-progress.ts';
import { watchRecovery } from './failure-recovery.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const exited = (path) =>
  Object.assign(new Error('ended'), {
    coreExit: { code: 2, signal: null, reason: 'exited with code 2', stderrPath: path },
  });
const confirmedReports = () => {
  const reports = new BootReports();
  reports.attempt().failed(exited('a'));
  reports.attempt().failed(exited('b'));
  return reports;
};
const serving = { state: 'serving', rpcPort: 4242, pid: 77 };

test("observing recovery never interferes with reporting the failure: a watch that throws is not the listeners' error, and every window hears it", async () => {
  const reports = new BootReports();
  const heard = [];
  reports.subscribe((report) => heard.push(report.failure));
  watchRecovery({
    ensureRoot() {},
    log() {},
    reports,
    runtimeRoot: 'C:\\absent\\runtime',
    readState: async () => serving,
    watch: () => {
      throw new Error('ENOENT');
    },
  });
  reports.subscribe((report) => heard.push(report.failure));
  reports.attempt().failed(exited('a'));
  const second = reports.attempt().failed(exited('b'));
  assert.ok(second.coreLaunchFailed, 'the resolver gets the launch failure, not a filesystem error');
  assert.ok(heard.at(-1), 'and the listeners after it heard the failure');
  await tick();
});

test('recovery makes sure the runtime directory exists, watches it, and only then reads the discovery: a core that came up in between is seen', async () => {
  const reports = confirmedReports();
  const order = [];
  watchRecovery({
    reports,
    runtimeRoot: 'C:\\data\\runtime',
    runs: () => true,
    log() {},
    ensureRoot: () => order.push('ensure'),
    watch: () => {
      order.push('watch');
      return { close() {} };
    },
    readState: async () => {
      order.push('read');
      return serving;
    },
  });
  await tick();
  assert.deepEqual(order, ['ensure', 'watch', 'read']);
  assert.equal(reports.confirmed(), null, 'the core that was up before the watch is seen by the read after it');
});

test('a watch that cannot be installed is recorded in the diagnostics log with its error, and the failure stands', async () => {
  const reports = confirmedReports();
  const logged = [];
  watchRecovery({
    reports,
    runtimeRoot: 'C:\\data\\runtime',
    readState: async () => ({ state: 'booting', rpcPort: null }),
    ensureRoot() {},
    watch: () => {
      throw new Error('EPERM: watch denied');
    },
    log: (event, fields) => logged.push([event, fields]),
  });
  await tick();
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'core-recovery-watch-failed');
  assert.match(logged[0][1].message, /EPERM/);
  assert.ok(reports.confirmed(), 'the card and Try again remain');
  const failing = [];
  watchRecovery({
    reports,
    runtimeRoot: 'r',
    readState: async () => serving,
    ensureRoot: () => {
      throw new Error('EACCES: cannot create');
    },
    watch() {
      throw new Error('unreachable');
    },
    log: (_event, fields) => failing.push(fields.message),
  });
  await tick();
  assert.match(failing[0], /EACCES/, 'a directory that cannot be made is recorded too');
});
test('a watch that stops is replaced, and the replacement looks at what it missed', async () => {
  const reports = confirmedReports();
  const ends = [];
  let installed = 0;
  let discovery = { state: 'booting', rpcPort: null, pid: 77 };
  watchRecovery({
    ensureRoot() {},
    log() {},
    reports,
    runtimeRoot: 'r',
    readState: async () => discovery,
    runs: () => true,
    watch: (_directory, _onChange, onEnd) => {
      installed += 1;
      ends.push(onEnd);
      return { close() {} };
    },
  });
  await tick();
  assert.equal(installed, 1);
  discovery = serving; // the change that the stopped watch could not tell of
  ends[0]();
  await tick();
  assert.equal(installed, 2, 'replaced');
  assert.equal(reports.confirmed(), null, 'and what happened meanwhile is seen');
});

test('a stale discovery document does not clear a real failure: a serving state naming a process that no longer runs is no core', async () => {
  const reports = confirmedReports();
  let alive = false;
  let onChange;
  watchRecovery({
    ensureRoot() {},
    log() {},
    reports,
    runtimeRoot: 'r',
    readState: async () => serving,
    runs: (pid) => (pid === 77 ? alive : false),
    watch: (_directory, change) => {
      onChange = change;
      return { close() {} };
    },
  });
  await tick();
  assert.ok(reports.confirmed(), 'left by a killed core');
  alive = true;
  onChange();
  await tick();
  assert.equal(reports.confirmed(), null, 'a live core that serves');
});

test('a read answers for the failure that started it: one outstanding when the failure was replaced does not clear the new one', async () => {
  const reports = confirmedReports();
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  let reads = 0;
  watchRecovery({
    ensureRoot() {},
    log() {},
    reports,
    runtimeRoot: 'r',
    runs: () => true,
    readState: () => (reads++ === 0 ? slow : new Promise(() => {})),
    watch: () => ({ close() {} }),
  });
  await tick();
  const first = reports.confirmed();
  reports.retry();
  reports.attempt().failed(exited('c'));
  assert.ok(reports.confirmed() && reports.confirmed() !== first, 'a new failure stands');
  release(serving);
  await tick();
  assert.ok(reports.confirmed(), "the old read, answering late, is not the new failure's");
});

// Established by measurement, kept as a test: the real directory watch tells of the discovery file's atomic replacement (a staging file
// renamed over daemon.json) made by another process, so recovery needs no polling interval.
test('the real directory watch fires for the atomic replacement of daemon.json by another process', async () => {
  const { mkdtempSync, rmSync, watch, writeFileSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-watch-'));
  try {
    writeFileSync(join(dir, 'daemon.json'), '{"v":0}');
    const named = [];
    const watcher = watch(dir, { persistent: false }, (_type, name) => named.push(String(name)));
    const code = `const fs=require('fs'),p=require('path');const t=p.join(${JSON.stringify(dir)},'daemon.json.tmp');fs.writeFileSync(t,'{"v":1}');fs.renameSync(t,p.join(${JSON.stringify(dir)},'daemon.json'));`;
    await new Promise((resolve) => spawn(process.execPath, ['-e', code]).on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    watcher.close();
    assert.ok(named.includes('daemon.json'), `events: ${named}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
