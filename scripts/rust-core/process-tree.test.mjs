import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endTree, helperPath, runTree, spawnTree } from './lib/process-tree.mjs';
import { assertNothingInside, assertTreeGone, startTimeOf } from './lib/process-probe.mjs';

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

// A script that starts a hung grandchild with the output given ('ignore' or 'inherit'), records both processes with their
// start times as first seen, then runs `after`. The grandchild is `detached` on Windows (it would otherwise end with its
// Node parent, which hides a tree that is not ended) and in the parent's group on POSIX, where the group is what the helper
// owns; `session: true` puts it in a session of its own (setsid), outside the group. Its stdin is a pipe held by its
// starter, so it exits when the starter is gone: nothing needs to be signalled to clean it up.
const treeScript = (dir, { out, after, session = false }) => `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startTimeOf } from ${JSON.stringify(PROBE)};
const gc = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1000)'], { stdio: ['pipe', ${JSON.stringify(out)}, ${JSON.stringify(out)}], detached: ${WINDOWS || session} });
const members = [process.pid, gc.pid];
writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify(await Promise.all(members.map(async (pid) => ({ pid, start: await startTimeOf(pid) })))));
${after}
`;

// The directory and the recorded members of a test. Nothing is signalled to clean up: the run's tree is owned by its helper
// (job object / process group), and a deliberately outside-the-group grandchild exits when its starter is gone.
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
    rmSync(dir, { recursive: true, force: true });
  }
}
test('at the deadline the child and the grandchild it started are both gone', () =>
  withTree(async (dir, members) => {
    // The child is the hung process (it holds the event loop open, as a hung core does); the test returns at runTree's deadline.
    const script = join(dir, 'tree.mjs');
    writeFileSync(script, treeScript(dir, { out: 'ignore', after: 'setInterval(() => {}, 1000);' }));
    await assert.rejects(runTree(process.execPath, [script], { label: 'lane x (filter y)', cwd: dir, deadlineMs: 30_000 }), /lane x \(filter y\) did not finish within 30000ms and was ended/);
    assert.equal(members().length, 2);
    await assertTreeGone(members());
  }));

test('a command that exits normally leaves nothing running: an independent child with its stdio ignored is ended too', () =>
  withTree(async (dir, members) => {
    const script = join(dir, 'leaves.mjs');
    writeFileSync(script, treeScript(dir, { out: 'ignore', after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'leaving lane', cwd: dir, deadlineMs: 60_000 });
    assert.equal(done.status, 0);
    assert.equal(members().length, 2);
    await assertTreeGone(members());
  }));

test('a parent that exits at once leaves a grandchild holding stdout: the run still finishes and the grandchild is ended', () =>
  withTree(async (dir, members) => {
    const script = join(dir, 'orphan.mjs');
    writeFileSync(script, treeScript(dir, { out: 'inherit', after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'orphan lane', cwd: dir, deadlineMs: 60_000 });
    assert.equal(done.status, 0);
    await assertTreeGone(members());
  }));

// POSIX: a descendant in a session of its own is outside the group. The helper does not hunt for it; it holds the run's
// stdout, so the run cannot finish before it is gone, and it goes when the parent that owns its stdin pipe exits.
test('a descendant in its own session is outside the group and exits with its starter', { skip: WINDOWS && 'POSIX sessions' }, () =>
  withTree(async (dir, members) => {
    const script = join(dir, 'session.mjs');
    writeFileSync(script, treeScript(dir, { out: 'inherit', session: true, after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'session lane', cwd: dir, deadlineMs: 60_000 });
    assert.equal(done.status, 0);
    await assertTreeGone(members());
  }));

test('a process outside the tree is not touched by ending it', () =>
  withTree(async (dir, members) => {
    // Neither started by runTree nor marked: what a pid reused after the parent's exit would be.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const script = join(dir, 'tree.mjs');
      writeFileSync(script, treeScript(dir, { out: 'ignore', after: 'setInterval(() => {}, 1000);' }));
      await assert.rejects(runTree(process.execPath, [script], { label: 'lane s', cwd: dir, deadlineMs: 30_000 }), /did not finish within 30000ms/);
      await assertTreeGone(members());
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
    writeFileSync(middle, treeScript(dir, { out: 'ignore', after: "console.log('ready'); setInterval(() => {}, 1000);" }));
    const parentScript = join(dir, 'parent.mjs');
    writeFileSync(
      parentScript,
      `import { spawnTree } from ${JSON.stringify(PROCESS_TREE)};
import { startTimeOf } from ${JSON.stringify(PROBE)};
const child = spawnTree(process.execPath, [${JSON.stringify(middle)}], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', async () => console.log(JSON.stringify({ helper: { pid: child.pid, start: await startTimeOf(child.pid) } })));
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
      await assertTreeGone(members());
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

test('binary stdout arrives byte for byte and non-ASCII arguments arrive as they were', async () => {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  const binary = await runTree(process.execPath, ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`], { label: 'binary', deadlineMs: 30_000 });
  assert.deepEqual([...binary.stdoutBytes], bytes);
  const args = ['héllo wörld', '日本語 テスト', '🙂 "quoted"', 'dir\\', ''];
  const done = await runTree(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], { label: 'args', deadlineMs: 30_000 });
  assert.deepEqual(JSON.parse(done.stdout), args);
});

test('a helper that dies before it reports is an error, never a success', async () => {
  await assert.rejects(runTree(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { label: 'lane k', deadlineMs: 30_000, onSpawn: (child) => child.kill('SIGKILL') }), /lane k: .*(ended without writing its report|no completion record|incomplete)/);
});

test('a finished helpers report is complete: launch null, completion record present', async () => {
  const child = spawnTree(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await exitOf(child);
  const outcome = child.treeOutcome();
  assert.equal(outcome.complete, true);
  assert.equal(outcome.launch, null);
});

test('a signal-killed program is reported with its signal, read before the result file is removed', { skip: WINDOWS && 'POSIX signals' }, async () => {
  const done = await runTree(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], { label: 'killed', deadlineMs: 30_000 });
  assert.equal(done.status, null);
  assert.equal(done.signal, 'SIGKILL');
});

test('index 3 of the stdio is the helper\'s channel: a fourth entry is refused', () => {
  assert.throws(() => spawnTree(process.execPath, ['-e', '0'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }), /index 3/);
});

test('the program and its descendants do not inherit the parent channel', { skip: WINDOWS && 'POSIX descriptors' }, async () => {
  const done = await runTree(process.execPath, ['-e', 'try { require("fs").fstatSync(3); console.log("open") } catch { console.log("closed") }'], { label: 'fd3', deadlineMs: 30_000 });
  assert.equal(done.stdout.trim(), 'closed');
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
  } finally {
    sleeper.kill();
    await exitOf(sleeper);
  }
  assert.equal(await startTimeOf(sleeper.pid), null);
});

test('--end-inside ends a process only when it is verified inside the directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'end-inside-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'end-inside-other-'));
  const exe = join(dir, WINDOWS ? 'inside.exe' : 'inside');
  copyFileSync(process.execPath, exe);
  const inside = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const endInside = (where) => spawnSync(helperPath(), ['--end-inside', where, String(inside.pid)], { encoding: 'utf8', timeout: 60_000 });
  try {
    const refused = endInside(elsewhere);
    assert.equal(refused.status, 3, refused.stderr);
    assert.equal(inside.exitCode, null, 'a process outside the directory is not ended');
    const ended = endInside(dir);
    if (process.platform === 'darwin') {
      assert.equal(ended.status, 4, 'macOS reports and ends nothing');
      assert.equal(inside.exitCode, null);
    } else {
      assert.equal(ended.status, 0, ended.stderr);
      await exitOf(inside);
    }
  } finally {
    inside.kill();
    await exitOf(inside);
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
test('a run that leaves a process inside its own directory fails naming it, and ends it where a verified handle exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'left-inside-'));
  const exe = join(dir, WINDOWS ? 'left.exe' : 'left');
  copyFileSync(process.execPath, exe);
  const left = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await assertNothingInside(join(tmpdir(), 'nothing-runs-in-here-' + process.pid)).then(() => {});
    await assert.rejects(assertNothingInside(dir), new RegExp(`pid ${left.pid} .*(has been ended|was not ended)`));
    if (process.platform !== 'darwin') await exitOf(left);
    else assert.equal(left.exitCode, null, 'macOS reports and ends nothing');
  } finally {
    left.kill();
    await exitOf(left);
    rmSync(dir, { recursive: true, force: true });
  }
});