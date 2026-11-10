import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endTree, runTree, spawnTree } from './lib/process-tree.mjs';
import { assertTreeGone, endIfSame, startTimeOf } from './lib/process-probe.mjs';

const PROCESS_TREE = new URL('./lib/process-tree.mjs', import.meta.url).href;
const PROBE = new URL('./lib/process-probe.mjs', import.meta.url).href;
const WINDOWS = process.platform === 'win32';

// A child that has not exited by now is hung: the wait fails with a message instead of waiting on.
const exitOf = (child) =>
  new Promise((resolveExit, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    const timer = setTimeout(() => reject(new Error(`child pid ${child.pid} did not exit within 30000ms`)), 30_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });

// A script that starts a hung grandchild of its own session/group (`detached`: setsid on POSIX, which a process-group kill
// does not reach) with the stdio given, records both processes with their start times as first seen (the identity a later
// kill compares), then runs `after`.
const treeScript = (dir, { grandchildStdio, after }) => `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startTimeOf } from ${JSON.stringify(PROBE)};
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ${grandchildStdio}, detached: true });
const members = [process.pid, gc.pid];
writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify(await Promise.all(members.map(async (pid) => ({ pid, start: await startTimeOf(pid) })))));
${after}
`;

// What a test started is ended on every path, a failed assertion included: each recorded process is ended only while it is
// still the one first seen (pid and start time), never by a pid alone.
async function withTree(body) {
  const dir = mkdtempSync(join(tmpdir(), 'process-tree-'));
  const extra = [];
  const members = () => {
    try {
      return [...JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')), ...extra];
    } catch {
      return extra;
    }
  };
  try {
    await body(dir, members, (record) => extra.push(record));
  } finally {
    for (const record of members()) await endIfSame(record);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('at the deadline the child and the grandchild it started are both gone', () =>
  withTree(async (dir, members) => {
    // The child is the hung process (it holds the event loop open, as a hung core does); the test returns at runTree's deadline.
    const script = join(dir, 'tree.mjs');
    writeFileSync(script, treeScript(dir, { grandchildStdio: "'ignore'", after: 'setInterval(() => {}, 1000);' }));
    let mark;
    await assert.rejects(runTree(process.execPath, [script], { label: 'lane x (filter y)', cwd: dir, deadlineMs: 30_000, onSpawn: (child) => (mark = child.treeMark) }), /lane x \(filter y\) did not finish within 30000ms and was ended/);
    assert.equal(members().length, 2);
    await assertTreeGone({ mark, members: members() });
  }));

test('a command that exits normally leaves nothing running: an independent child with its stdio ignored is ended too', () =>
  withTree(async (dir, members) => {
    const script = join(dir, 'leaves.mjs');
    writeFileSync(script, treeScript(dir, { grandchildStdio: "'ignore'", after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'leaving lane', cwd: dir, deadlineMs: 60_000 });
    assert.equal(done.status, 0);
    assert.equal(members().length, 2);
    await assertTreeGone({ mark: done.mark, members: members() });
  }));

test('a parent that exits at once leaves a grandchild holding stdout: the run still finishes and the grandchild is ended', () =>
  withTree(async (dir, members) => {
    const script = join(dir, 'orphan.mjs');
    writeFileSync(script, treeScript(dir, { grandchildStdio: "['ignore', 'inherit', 'inherit']", after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'orphan lane', cwd: dir, deadlineMs: 60_000 });
    assert.equal(done.status, 0);
    await assertTreeGone({ mark: done.mark, members: members() });
  }));

test('a process outside the tree is not touched by ending it', () =>
  withTree(async (dir, members) => {
    // Neither started by runTree nor marked: what a pid reused after the parent's exit would be.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const script = join(dir, 'tree.mjs');
      writeFileSync(script, treeScript(dir, { grandchildStdio: "'ignore'", after: 'setInterval(() => {}, 1000);' }));
      let mark;
      await assert.rejects(runTree(process.execPath, [script], { label: 'lane s', cwd: dir, deadlineMs: 30_000, onSpawn: (child) => (mark = child.treeMark) }), /did not finish within 30000ms/);
      await assertTreeGone({ mark, members: members() });
      assert.equal(stranger.exitCode, null, 'the stranger is still running');
      assert.equal(stranger.kill(0), true);
    } finally {
      stranger.kill();
      await exitOf(stranger);
    }
  }));

test('when the Node process that started the tree is killed abruptly, nothing of the tree is left', () =>
  withTree(async (dir, members, remember) => {
    // parent.mjs starts the tree and reports; this test then kills it with no chance to clean up.
    const middle = join(dir, 'middle.mjs');
    writeFileSync(middle, treeScript(dir, { grandchildStdio: "'ignore'", after: "console.log('ready'); setInterval(() => {}, 1000);" }));
    const parentScript = join(dir, 'parent.mjs');
    writeFileSync(
      parentScript,
      `import { spawnTree } from ${JSON.stringify(PROCESS_TREE)};
import { startTimeOf } from ${JSON.stringify(PROBE)};
const child = spawnTree(process.execPath, [${JSON.stringify(middle)}], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', async () => console.log(JSON.stringify({ mark: child.treeMark, helper: { pid: child.pid, start: await startTimeOf(child.pid) } })));
setInterval(() => {}, 1000);
`,
    );
    const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const report = await new Promise((resolveReport, reject) => {
        const timer = setTimeout(() => reject(new Error('the parent did not report its tree within 60000ms')), 60_000);
        let text = '';
        parent.stdout.on('data', (chunk) => {
          text += chunk;
          const line = text.split('\n').find((l) => l.startsWith('{'));
          if (line) {
            clearTimeout(timer);
            resolveReport(JSON.parse(line));
          }
        });
        parent.once('exit', () => reject(new Error('the parent exited before it reported its tree')));
      });
      remember(report.helper);
      assert.equal(members().length, 3);
      parent.kill('SIGKILL');
      await exitOf(parent);
      await assertTreeGone({ mark: report.mark, members: members() });
    } finally {
      parent.kill('SIGKILL');
    }
  }));

test('a finished child answers its status, stdout and stderr', async () => {
  const done = await runTree(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], { label: 'x', deadlineMs: 30_000 });
  assert.equal(done.status, 3);
  assert.equal(done.stdout.trim(), 'out');
  assert.equal(done.stderr.trim(), 'err');
});

test('every exit code of the program arrives unchanged, 125 and 126 and an NTSTATUS included, none read as a launch failure', async () => {
  const codes = [125, 126, 127, 255, ...(WINDOWS ? [0xc0000005, 0xc0000409] : [])];
  for (const code of codes) {
    const done = await runTree(process.execPath, ['-e', `process.exit(${code})`], { label: `exit ${code}`, deadlineMs: 30_000 });
    // What Node itself reports for the same program run directly is the reference.
    assert.equal(done.status, spawnSync(process.execPath, ['-e', `process.exit(${code})`]).status, `exit code ${code}`);
  }
});

test('a program that dies of a signal reports the signal, not an exit code', { skip: WINDOWS && 'POSIX signals' }, async () => {
  const done = await runTree(process.execPath, ['-e', 'process.kill(process.pid, "SIGSEGV")'], { label: 'signal', deadlineMs: 30_000 });
  assert.equal(done.status, null);
  assert.equal(done.signal, 'SIGSEGV');
});

test('binary stdout arrives byte for byte and non-ASCII arguments arrive as they were', async () => {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  const binary = await runTree(process.execPath, ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`], { label: 'binary', deadlineMs: 30_000 });
  assert.deepEqual([...binary.stdoutBytes], bytes);
  const args = ['héllo wörld', '日本語 テスト', '🙂 "quoted"', 'dir\\', ''];
  const done = await runTree(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], { label: 'args', deadlineMs: 30_000 });
  assert.deepEqual(JSON.parse(done.stdout), args);
});

test('the tree mark stays in the program\'s environment, so its descendants carry it', async () => {
  const done = await runTree(process.execPath, ['-e', 'process.stdout.write(process.env.MIXDOG_TREE_MARK ?? "")'], { label: 'mark', deadlineMs: 30_000 });
  assert.equal(done.stdout, done.mark);
  assert.match(done.mark, /^[0-9a-f-]{36}$/);
});

test('a command that cannot start rejects with its label and the spawn error code; a deadline has no such code', async () => {
  await assert.rejects(runTree('no-such-program-anywhere', [], { label: 'lane z', deadlineMs: 30_000 }), { code: 'ENOENT', message: /lane z could not run: spawn no-such-program-anywhere ENOENT/ });
  await assert.rejects(runTree(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { label: 'lane h', deadlineMs: 3000 }), (error) => error.code === undefined && /lane h did not finish/.test(error.message));
});

test('ending a child that already exited is not an error', async () => {
  const child = spawnTree(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await exitOf(child);
  assert.deepEqual(await endTree(child), { killed: [] });
});

test('a helper that does not exit after it was told to end the tree is its own error', async () => {
  const stuck = Object.assign(new EventEmitter(), { pid: 2_000_000_000, exitCode: null, signalCode: null, kill: () => true, stdio: [null, null, null, { destroy() {} }] });
  await assert.rejects(endTree(stuck, { deadlineMs: 50 }), /tree helper of pid 2000000000 did not exit within 50ms/);
});

test('a start time identifies a process: it differs between two processes and is null for none', async () => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const mine = await startTimeOf(sleeper.pid);
    assert.ok(mine);
    assert.notEqual(mine, await startTimeOf(process.pid));
    assert.equal(await endIfSame({ pid: sleeper.pid, start: 'not-its-start-time' }), false, 'a pid with another start time is not ended');
    assert.equal(sleeper.exitCode, null);
    assert.equal(await endIfSame({ pid: sleeper.pid, start: mine }), true);
    await exitOf(sleeper);
    assert.equal(await startTimeOf(sleeper.pid), null);
  } finally {
    sleeper.kill();
  }
});