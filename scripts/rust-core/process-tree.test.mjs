import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endTree, runTree, spawnTree } from './lib/process-tree.mjs';

// A child that has not exited by now is hung: the wait fails with a message instead of waiting on.
const exitOf = (child) =>
  new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`child pid ${child.pid} did not exit within 30000ms`)), 30_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('at the deadline the child and the grandchild it started are both gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'process-tree-'));
  try {
    // The child is the hung process (it holds the event loop open, as a hung core does); the test returns at runTree's deadline.
    const script = join(dir, 'tree.mjs');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nwriteFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify([process.pid, gc.pid]));\nsetInterval(() => {}, 1000);\n`,
    );
    await assert.rejects(runTree(process.execPath, [script], { label: 'lane x (filter y)', cwd: dir, deadlineMs: 4000 }), /lane x \(filter y\) did not finish within 4000ms and was ended/);
    const pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} is still running`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a parent that exits at once leaves a grandchild holding stdout: the deadline still ends it and says what it ended', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'process-tree-'));
  try {
    const script = join(dir, 'orphan.mjs');
    // The grandchild inherits stdout (so runTree stays pending; on Windows only a detached child keeps the pipe open) and the parent leaves without waiting for it.
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32' });\nwriteFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify([process.pid, gc.pid]));\nprocess.exit(0);\n`,
    );
    let message = '';
    await runTree(process.execPath, [script], { label: 'orphan lane', cwd: dir, deadlineMs: 4000 }).catch((error) => (message = error.message));
    const [parent, grandchild] = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
    assert.match(message, /orphan lane did not finish within 4000ms and was ended/);
    assert.equal(alive(parent), false);
    assert.equal(alive(grandchild), false, `the grandchild pid ${grandchild} is still running`);
    assert.match(message, process.platform === 'win32' ? new RegExp(`ended: .*\\b${grandchild}\\b`) : /ended: -\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished child answers its status, stdout and stderr', async () => {
  const done = await runTree(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], { label: 'x', deadlineMs: 30_000 });
  assert.equal(done.status, 3);
  assert.equal(done.stdout.trim(), 'out');
  assert.equal(done.stderr.trim(), 'err');
});

test('a command that cannot start rejects with its label', async () => {
  await assert.rejects(runTree('no-such-program-anywhere', [], { label: 'lane z', deadlineMs: 30_000 }), /lane z could not run: spawn no-such-program-anywhere ENOENT/);
});

test('ending a child that already exited is not an error', async () => {
  const child = spawnTree(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await exitOf(child);
  assert.deepEqual(await endTree(child), { killed: [] });
});

test('a kill that fails is its own error', { skip: process.platform !== 'win32' && 'Windows: taskkill answers 128 for a pid that is not ours' }, async () => {
  // A pid with no process behind it, on a child that has not exited: the kill finds nothing to end and says so.
  await assert.rejects(endTree({ pid: 2_000_000_000, exitCode: null, signalCode: null }), /taskkill of the process tree of pid 2000000000 exited 128/);
});
