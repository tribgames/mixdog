import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';
import { waitForComputerWorkerExit } from './worker-capacity.ts';

test('a successful kill request is not confused with an observed process exit', async () => {
  const child = Object.assign(new EventEmitter(), { killed: true, exitCode: null, signalCode: null });
  assert.equal(await waitForComputerWorkerExit(child, 1), false);
  const stopped = waitForComputerWorkerExit(child, 100);
  child.emit('exit', 0);
  assert.equal(await stopped, true);
});

test('worker capacity counts retiring children until exit without evicting another session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-capacity-'));
  const children = [];
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
    maxWorkers: 2,
    spawnProcess: () => {
      const child = new EventEmitter();
      Object.assign(child, {
        pid: 100 + children.length, killed: false, exitCode: null, signalCode: null,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill() { this.killed = true; return true; },
      });
      children.push(child);
      return child;
    },
  });
  try {
    const a = pool.ensurePowerShell('a');
    const b = pool.ensurePowerShell('b');
    assert.equal(pool.ensurePowerShell('b'), b);
    assert.throws(() => pool.ensurePowerShell('c'), /computer_capacity_exhausted/);
    assert.equal(pool.workerLastUsedAt.has('c'), false);
    pool.retirePowerShell(a, new Error('test retirement'));
    assert.throws(() => pool.ensurePowerShell('c'), /computer_capacity_exhausted/);
    a.emit('exit', 0);
    assert.ok(pool.ensurePowerShell('c'));
    assert.equal(b.killed, false);
    assert.equal(children.length, 3);
  } finally {
    for (const child of children) {
      child.emit('exit', 0);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});
