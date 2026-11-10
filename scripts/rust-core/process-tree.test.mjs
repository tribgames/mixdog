import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endTree, runTree, spawnTree } from './lib/process-tree.mjs';
import { endAndWait, waitGone } from './lib/process-probe.mjs';

// A child that has not exited by now is hung: the wait fails with a message instead of waiting on.
const exitOf = (child) =>
  new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`child pid ${child.pid} did not exit within 30000ms`)), 30_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });

// A script that starts `setInterval` as a grandchild (stdio as given), records both pids in pids.json, then runs `after`.
const treeScript = (dir, { grandchildStdio, after }) =>
  `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ${grandchildStdio}, detached: process.platform === 'win32' });\nwriteFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify([process.pid, gc.pid]));\n${after}\n`;

// Every pid a test recorded is ended and awaited on every path, a failed assertion included.
async function withTree(body) {
  const dir = mkdtempSync(join(tmpdir(), 'process-tree-'));
  const pids = () => {
    try {
      return JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
    } catch {
      return [];
    }
  };
  try {
    await body(dir, pids);
  } finally {
    for (const pid of pids()) await endAndWait(pid);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('at the deadline the child and the grandchild it started are both gone', () =>
  withTree(async (dir, pids) => {
    // The child is the hung process (it holds the event loop open, as a hung core does); the test returns at runTree's deadline.
    const script = join(dir, 'tree.mjs');
    writeFileSync(script, treeScript(dir, { grandchildStdio: "'ignore'", after: 'setInterval(() => {}, 1000);' }));
    await assert.rejects(runTree(process.execPath, [script], { label: 'lane x (filter y)', cwd: dir, deadlineMs: 6000 }), /lane x \(filter y\) did not finish within 6000ms and was ended/);
    assert.equal(pids().length, 2);
    for (const pid of pids()) await waitGone(pid);
  }));

test('a command that exits normally leaves nothing running: an independent child with its stdio ignored is ended too', () =>
  withTree(async (dir, pids) => {
    const script = join(dir, 'leaves.mjs');
    writeFileSync(script, treeScript(dir, { grandchildStdio: "'ignore'", after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'leaving lane', cwd: dir, deadlineMs: 60_000 });
    assert.equal(done.status, 0);
    assert.equal(pids().length, 2);
    for (const pid of pids()) await waitGone(pid);
  }));

test('a parent that exits at once leaves a grandchild holding stdout: the run still finishes and the grandchild is ended', () =>
  withTree(async (dir, pids) => {
    const script = join(dir, 'orphan.mjs');
    writeFileSync(script, treeScript(dir, { grandchildStdio: "['ignore', 'inherit', 'inherit']", after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'orphan lane', cwd: dir, deadlineMs: 60_000 });
    assert.equal(done.status, 0);
    for (const pid of pids()) await waitGone(pid);
  }));

test('a process outside the tree is not touched by ending it', () =>
  withTree(async (dir, pids) => {
    // Neither started by runTree nor in its job: what a pid reused after the parent's exit would be.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const script = join(dir, 'tree.mjs');
      writeFileSync(script, treeScript(dir, { grandchildStdio: "'ignore'", after: 'setInterval(() => {}, 1000);' }));
      await assert.rejects(runTree(process.execPath, [script], { label: 'lane s', cwd: dir, deadlineMs: 6000 }), /did not finish within 6000ms/);
      for (const pid of pids()) await waitGone(pid);
      assert.equal(stranger.exitCode, null, 'the stranger is still running');
      assert.equal(stranger.kill(0), true);
    } finally {
      stranger.kill();
      await exitOf(stranger);
    }
  }));

test('a finished child answers its status, stdout and stderr', async () => {
  const done = await runTree(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], { label: 'x', deadlineMs: 30_000 });
  assert.equal(done.status, 3);
  assert.equal(done.stdout.trim(), 'out');
  assert.equal(done.stderr.trim(), 'err');
});

test('an argument with spaces, quotes and a trailing backslash reaches the program as it was', async () => {
  const args = ['two words', 'say "hi"', 'dir\\', ''];
  const done = await runTree(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], { label: 'args', deadlineMs: 30_000 });
  assert.deepEqual(JSON.parse(done.stdout), args);
});

test('a command that cannot start rejects with its label', async () => {
  await assert.rejects(runTree('no-such-program-anywhere', [], { label: 'lane z', deadlineMs: 30_000 }), { code: 'ENOENT', message: /lane z could not run: spawn no-such-program-anywhere ENOENT/ });
  // A deadline is not ENOENT: a caller that skips on a missing program must not skip on a hung one.
  await assert.rejects(runTree(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { label: 'lane h', deadlineMs: 3000 }), (error) => error.code === undefined && /lane h did not finish/.test(error.message));
});

test('ending a child that already exited is not an error', async () => {
  const child = spawnTree(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await exitOf(child);
  assert.deepEqual(await endTree(child), { killed: [] });
});

test('a launcher that does not exit after the kill is its own error', { skip: process.platform !== 'win32' && 'Windows: the launcher is killed and awaited' }, async () => {
  const stuck = Object.assign(new EventEmitter(), { pid: 2_000_000_000, exitCode: null, signalCode: null, kill: () => true });
  await assert.rejects(endTree(stuck, { deadlineMs: 50 }), /job launcher of pid 2000000000 did not exit within 50ms/);
});