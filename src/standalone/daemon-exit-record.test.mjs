import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { beginDaemonSpawnCapture } from '../session-runtime/services/daemon-crash-capture.mjs';
import {
  describeExit,
  findCaptureRecordFor,
  installDaemonExitRecorder,
  reconcileLostDaemonCaptures,
} from '../session-runtime/services/daemon-crash-capture/daemon-exit-record.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-exit-record-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dir = join(dataDir, 'daemon-crash');
  mkdirSync(dir, { recursive: true });
  return { dataDir, dir };
}

function sidecar(dir, stem, patch) {
  const file = join(dir, `${stem}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      kind: 'mixdog-daemon-crash-capture',
      launcher: 'session-client',
      launcherPid: 1,
      pid: 4242,
      spawnedAt: '2026-09-29T00:00:00.000Z',
      ready: true,
      exitedAt: null,
      exitCode: null,
      exitSignal: null,
      ...patch,
    })
  );
  return file;
}

test('describeExit names signals, known external-termination codes and plain codes', () => {
  assert.match(describeExit(1073807364, null), /0x40010004/);
  assert.match(describeExit(null, 'SIGKILL'), /SIGKILL/);
  assert.equal(describeExit(0, null), 'exited normally (code 0)');
  assert.equal(describeExit(2, null), 'exited with code 2');
});

test('the daemon records its shutdown reason and exit code into its own sidecar on exit', (t) => {
  const { dataDir, dir } = fixture(t);
  const file = sidecar(dir, 'daemon-20260929-000000-1-aaaa', {});
  const target = new EventEmitter();
  const recorder = installDaemonExitRecorder({ dataDir, pid: 4242, target, startedAtMs: Date.now() - 5000 });
  recorder.setReason('shutdown: IPC shutdown', 0);
  target.emit('exit', 0);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(record.exitCode, 0);
  assert.ok(record.exitedAt);
  assert.match(record.exitReason, /shutdown: IPC shutdown/);
  assert.equal(record.daemonExit.code, 0);
  assert.ok(record.daemonExit.uptimeMs >= 5000);
  assert.ok(record.daemonExit.rssBytes > 0);
});

test('an exit with no stated reason still records its code, and a fatal error records its stack', (t) => {
  const { dataDir, dir } = fixture(t);
  const file = sidecar(dir, 'daemon-20260929-000000-1-bbbb', {});
  const target = new EventEmitter();
  installDaemonExitRecorder({ dataDir, pid: 4242, target });
  target.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException');
  assert.match(JSON.parse(readFileSync(file, 'utf8')).daemonExit.error, /boom/);
  target.emit('exit', 1);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(record.exitCode, 1);
  assert.match(record.exitReason, /fatal uncaughtException/);
  assert.match(record.daemonExit.error, /boom/);
});

test('the launcher exit write keeps the daemon block and fills a missing reason', (t) => {
  const { dataDir, dir } = fixture(t);
  const capture = beginDaemonSpawnCapture({ dir, dataDir, log: () => {}, prune: false });
  const child = new EventEmitter();
  child.pid = 5151;
  capture.track(child, { detached: false });
  capture.noteReady();
  const target = new EventEmitter();
  installDaemonExitRecorder({ dataDir, pid: 5151, target }).setReason('shutdown: SIGTERM', 0);
  target.emit('exit', 0);
  child.emit('exit', 0, null);
  const record = JSON.parse(readFileSync(capture.recordPath, 'utf8'));
  assert.equal(record.daemonExit.code, 0);
  assert.match(record.exitReason, /SIGTERM/);

  const killed = beginDaemonSpawnCapture({ dir, dataDir, log: () => {}, prune: false, nonce: () => 'cccc' });
  const other = new EventEmitter();
  other.pid = 5252;
  killed.track(other, {});
  other.emit('exit', 1073807364, null);
  const after = JSON.parse(readFileSync(killed.recordPath, 'utf8'));
  assert.equal(after.exitCode, 1073807364);
  assert.match(after.exitReason, /terminated externally/);
});

test('a boot that vanished without any hook is marked unrecorded-termination by the next daemon', (t) => {
  const { dir } = fixture(t);
  const lost = sidecar(dir, 'daemon-20260929-000000-1-dddd', { pid: 111 });
  const alive = sidecar(dir, 'daemon-20260929-000001-1-eeee', { pid: 222 });
  const recorded = sidecar(dir, 'daemon-20260929-000002-1-ffff', {
    pid: 333,
    exitedAt: '2026-09-29T01:00:00.000Z',
    exitCode: 0,
  });
  const marked = reconcileLostDaemonCaptures({ dir, selfPid: 999, pidAlive: (pid) => pid === 222 });
  assert.equal(marked, 1);
  assert.match(JSON.parse(readFileSync(lost, 'utf8')).exitReason, /^unrecorded-termination/);
  assert.equal(JSON.parse(readFileSync(alive, 'utf8')).exitReason, undefined);
  assert.equal(JSON.parse(readFileSync(recorded, 'utf8')).exitReason, undefined);
  assert.equal(reconcileLostDaemonCaptures({ dir, selfPid: 999, pidAlive: (pid) => pid === 222 }), 0, 'idempotent');
  assert.equal(findCaptureRecordFor(111, { dir })?.file, lost);
});
