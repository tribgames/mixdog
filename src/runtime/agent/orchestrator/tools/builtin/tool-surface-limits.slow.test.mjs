import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ResourceAdmissionController } from '../../../../shared/resource-admission.mjs';
import { getBackgroundTask } from '../../../../shared/background-tasks.mjs';
import { executeBuiltinTool } from '../builtin.mjs';
import { execShellCommand } from '../shell-command.mjs';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('list meta adds line counts for text files only', async () => {
  const dir = tempDir('mixdog-list-lines-');
  try {
    writeFileSync(join(dir, 'three.txt'), 'a\nb\nc\n');
    writeFileSync(join(dir, 'nonl.txt'), 'a\nb');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 0, 10, 10]));
    writeFileSync(join(dir, 'big.txt'), 'x\n'.repeat(1_100_000));
    const out = await executeBuiltinTool('list', { path: dir, meta: true }, dir);
    const row = (name) =>
      out.split('\n').find((line) => line.startsWith(`${name}\t`) || line.includes(`${name}\tfile`));
    assert.match(row('three.txt'), /\tfile\t6\t[^\t]+\t[^\t]+\t3$/);
    assert.match(row('nonl.txt'), /\tfile\t3\t[^\t]+\t[^\t]+\t2$/);
    assert.match(row('bin.dat'), /\tfile\t8\t[^\t]+\t[^\t]+$/);
    assert.match(row('big.txt'), /\tfile\t2200000\t[^\t]+\t[^\t]+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read of 11 files returns 10 bodies and names the skipped one', async () => {
  const dir = tempDir('mixdog-read-cap-');
  try {
    const files = Array.from({ length: 11 }, (_, index) => {
      const file = join(dir, `f${index}.txt`);
      writeFileSync(file, `body-${index}\n`);
      return file;
    });
    const out = String(await executeBuiltinTool('read', { file_path: files }, dir));
    for (let index = 0; index < 10; index++) assert.match(out, new RegExp(`body-${index}\\b`));
    assert.doesNotMatch(out, /body-10\b/);
    const lastLine = out.trimEnd().split('\n').pop();
    assert.match(lastLine, /skipped 1 more file/);
    assert.ok(lastLine.includes('f10.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SLEEP_SEC = process.platform === 'win32' ? 'Start-Sleep -Seconds' : 'sleep';

test('shell wait_ms keeps a ~15s command in the foreground', { timeout: 60_000 }, async () => {
  const out = String(
    (await executeBuiltinTool('shell', { command: `${SLEEP_SEC} 15; echo done-wait`, wait_ms: 30000 }, process.cwd()))
      .result
  );
  assert.match(out, /done-wait/);
  assert.doesNotMatch(out, /task_id/);
});

test('shell rejects out-of-range wait_ms', async () => {
  const out = String(await executeBuiltinTool('shell', { command: 'echo x', wait_ms: 5 }, process.cwd()));
  assert.match(out, /wait_ms/);
});

test('saturated admission queues the command as a background task that completes', { timeout: 60_000 }, async () => {
  const admission = new ResourceAdmissionController({ limits: { maxShells: 1, minFreeMemoryMb: 0, maxRssMb: 0 } });
  const base = {
    shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    shellArg: process.platform === 'win32' ? '/c' : '-c',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 0,
    backgroundOnTimeout: true,
    admission,
  };
  const keepAlive = setInterval(() => {}, 1000);
  const holder = await admission.acquire('shell', { label: 'holder' });
  const started = execShellCommand({ ...base, command: 'echo queued-ok', admissionWaitMs: 1200 });
  const result = await started;
  assert.equal(result.backgrounded, true);
  const taskId = /task_id: (\S+?)\]/.exec(result.backgroundMessage)?.[1];
  assert.ok(taskId, result.backgroundMessage);
  assert.equal(getBackgroundTask(taskId).status, 'running');
  await holder.release();
  const task = getBackgroundTask(taskId);
  // The caller releases per-command artifacts when this settles.
  assert.equal(result.settled, task.promise);
  await task.promise;
  assert.equal(task.status, 'completed');
  assert.match(String(task.result.output), /queued-ok/);
  clearInterval(keepAlive);
});
