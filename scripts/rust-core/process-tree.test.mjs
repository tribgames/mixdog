import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endTree, helperPath, runTree, spawnTree } from './lib/process-tree.mjs';
import { assertNothingInside, assertTreeEnded, leakGuard, pidsOfExecutable, processesInside, startTimeOf } from './lib/process-probe.mjs';

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

// The close of `child` (all its stdio closed too), or a rejection naming it.
const closeOf = (child, what) =>
  new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not close within 60000ms`)), 60_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolveClose();
    });
  });

const firstData = (stream, what) =>
  new Promise((resolveData, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within 60000ms`)), 60_000);
    stream.once('data', () => {
      clearTimeout(timer);
      resolveData();
    });
  });

// How long a fixture lives when nothing ends it (the leak guard; see leakGuard: a guard that fires fails the test).
const LIFE_MS = 90_000;

// A script that starts a hung grandchild with the output given ('ignore' or 'inherit'), records both processes with their
// start times as first seen, then runs `after`. The grandchild is `detached` on Windows (it would otherwise end with its
// Node parent, which hides a tree that is not ended) and in the parent's group on POSIX, where the group is what the helper
// owns. It depends on its starter in no way: no pipe to it, stdin ignored, nothing it waits for from it, so only the end of
// the tree removes it. Both carry the leak guard: what a failing run leaves behind goes away by itself (a hung program would
// otherwise hold the test runner's pipes open for good), and leaves a marker that fails the test's check of the tree.
const treeScript = (dir, { out, after }) => `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startTimeOf } from ${JSON.stringify(PROBE)};
${leakGuard(dir, LIFE_MS)}
const gc = spawn(process.execPath, ['-e', ${JSON.stringify(`${leakGuard(dir, LIFE_MS)} setInterval(() => {}, 1000)`)}], { stdio: ['ignore', ${JSON.stringify(out)}, ${JSON.stringify(out)}], detached: ${WINDOWS} });
const members = [process.pid, gc.pid];
writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify(await Promise.all(members.map(async (pid) => ({ pid, start: await startTimeOf(pid) })))));
${after}
`;

// The directory and the recorded members of a test. Nothing is signalled to clean up: the run's tree is owned by its helper
// (job object / process group). `track(child)` registers a started helper: when the behaviour under test fails and leaves
// the run half-ended, the last resort is to ask that very helper to end its tree (never a kill by a looked-up number).
async function withTree(body) {
  const dir = mkdtempSync(join(tmpdir(), 'process-tree-'));
  const extra = [];
  const tracked = [];
  const members = () => {
    try {
      return [...JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')), ...extra];
    } catch {
      return extra;
    }
  };
  try {
    await body(dir, members, (record) => extra.push(record), (child) => tracked.push(child));
  } finally {
    const failures = [];
    for (const child of tracked) await endTree(child).catch((error) => failures.push(error.message));
    rmSync(dir, { recursive: true, force: true });
    if (failures.length) throw new Error(`last-resort end of a tracked helper failed: ${failures.join('; ')}`);
  }
}
test('at the deadline the child and the grandchild it started are both gone', () =>
  withTree(async (dir, members, _remember, track) => {
    // The child is the hung process (it holds the event loop open, as a hung core does); the test returns at runTree's deadline.
    const script = join(dir, 'tree.mjs');
    writeFileSync(script, treeScript(dir, { out: 'ignore', after: 'setInterval(() => {}, 1000);' }));
    await assert.rejects(runTree(process.execPath, [script], { label: 'lane x (filter y)', cwd: dir, deadlineMs: 30_000, onSpawn: track }), /lane x \(filter y\) did not finish within 30000ms and was ended/);
    assert.equal(members().length, 2);
    await assertTreeEnded(dir, members());
  }));

test('a command that exits normally leaves nothing running: an independent child with its stdio ignored is ended too', () =>
  withTree(async (dir, members, _remember, track) => {
    const script = join(dir, 'leaves.mjs');
    writeFileSync(script, treeScript(dir, { out: 'ignore', after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'leaving lane', cwd: dir, deadlineMs: 60_000, onSpawn: track });
    assert.equal(done.status, 0);
    assert.equal(members().length, 2);
    await assertTreeEnded(dir, members());
  }));

test('a parent that exits at once leaves a grandchild holding stdout: the run still finishes and the grandchild is ended', () =>
  withTree(async (dir, members, _remember, track) => {
    const script = join(dir, 'orphan.mjs');
    writeFileSync(script, treeScript(dir, { out: 'inherit', after: 'process.exit(0);' }));
    const done = await runTree(process.execPath, [script], { label: 'orphan lane', cwd: dir, deadlineMs: 60_000, onSpawn: track });
    assert.equal(done.status, 0);
    await assertTreeEnded(dir, members());
  }));

// The former test "a descendant in its own session exits with its starter" is gone: its grandchild left by itself when its
// starter's stdin pipe closed, so it proved nothing about the helper. Escaped descendants are tested in tree-helper.test.mjs
// with one that depends on nothing.

test('a process outside the tree is not touched by ending it', () =>
  withTree(async (dir, members, _remember, track) => {
    // Neither started by runTree nor marked: what a pid reused after the parent's exit would be.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const script = join(dir, 'tree.mjs');
      writeFileSync(script, treeScript(dir, { out: 'ignore', after: 'setInterval(() => {}, 1000);' }));
      await assert.rejects(runTree(process.execPath, [script], { label: 'lane s', cwd: dir, deadlineMs: 30_000, onSpawn: track }), /did not finish within 30000ms/);
      await assertTreeEnded(dir, members());
      assert.equal(stranger.exitCode, null, 'the stranger is still running');
      assert.equal(stranger.kill(0), true);
    } finally {
      stranger.kill();
      await exitOf(stranger);
    }
  }));

test('when the Node process that started the tree is killed abruptly, nothing of the tree is left', () =>
  withTree(async (dir, members, remember) => {
    // parent.mjs starts the tree and reports; this test then kills it with no chance to clean up. The program's stdout, and
    // the grandchild's, is the pipe this test reads from: that pipe reaches end-of-file only when every process holding it
    // (parent.mjs, the helper, the program, the grandchild) is gone, which is the event that the helper saw its parent die
    // and finished ending the tree. Nothing is waited for by time.
    const middle = join(dir, 'middle.mjs');
    writeFileSync(middle, treeScript(dir, { out: 'inherit', after: "console.log('ready'); setInterval(() => {}, 1000);" }));
    const parentScript = join(dir, 'parent.mjs');
    writeFileSync(
      parentScript,
      `import { spawnTree } from ${JSON.stringify(PROCESS_TREE)};
import { startTimeOf } from ${JSON.stringify(PROBE)};
const child = spawnTree(process.execPath, [${JSON.stringify(middle)}], { stdio: ['ignore', 'inherit', 'inherit'] });
console.log(JSON.stringify({ helper: { pid: child.pid, start: await startTimeOf(child.pid) } }));
setInterval(() => {}, 1000);
`,
    );
    const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'pipe', 'inherit'] });
    let timer;
    try {
      const report = await new Promise((resolveReport, reject) => {
        timer = setTimeout(() => reject(new Error('the parent did not report its tree within 60000ms')), 60_000);
        let text = '';
        parent.stdout.on('data', (chunk) => {
          text += chunk;
          const line = text.split('\n').find((l) => l.startsWith('{'));
          if (line && text.includes('ready')) resolveReport(JSON.parse(line));
        });
        parent.once('exit', () => reject(new Error('the parent exited before it reported its tree')));
      });
      clearTimeout(timer);
      remember(report.helper);
      assert.equal(members().length, 3);
      const closed = new Promise((resolveClose, reject) => {
        timer = setTimeout(() => reject(new Error('the pipe held by the whole tree did not reach end-of-file within 60000ms of the parent being killed')), 60_000);
        parent.once('close', resolveClose);
      });
      parent.kill('SIGKILL');
      await closed;
      clearTimeout(timer);
      await assertTreeEnded(dir, members());
    } finally {
      clearTimeout(timer);
      parent.kill('SIGKILL');
      await exitOf(parent);
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
    assert.equal(done.status, spawnSync(process.execPath, ['-e', `process.exit(${code})`], { timeout: 30_000 }).status, `exit code ${code}`);
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

// The program says it has started, and ends itself when its stdin closes (nothing else could reach it once a POSIX helper is
// dead): the test, not the helper, ends it.
const STDIN_BOUND = 'console.log("started"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))';

test('a helper that dies before it reports is an error, never a success, and its tree is not called ended', async () => {
  const child = spawnTree(process.execPath, ['-e', STDIN_BOUND], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const closed = closeOf(child, `the killed helper ${child.pid} with its program`);
  try {
    await firstData(child.stdout, 'the program starting');
    child.kill('SIGKILL');
  } finally {
    child.stdin.end();
  }
  await closed;
  assert.equal(child.treeOutcome(), null, 'a helper that died wrote no report');
  if (!WINDOWS) await assert.rejects(endTree(child), /died of SIGKILL, so the end of its tree cannot be established/);
});

test('a helper killed after endTree found it alive, before it finished ending the tree, makes endTree fail', { skip: WINDOWS && 'Windows ends a tree by killing its helper: the job ends every member' }, async () => {
  const child = spawnTree(process.execPath, ['-e', STDIN_BOUND], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const closed = closeOf(child, `the killed helper ${child.pid} with its program`);
  try {
    await firstData(child.stdout, 'the program starting');
    // SIGKILL before endTree runs, in the same turn: Node has not seen the exit, so endTree finds the helper alive, asks it
    // and waits for it; the helper can run nothing after the kill, so it cannot have ended its tree.
    child.kill('SIGKILL');
    await assert.rejects(endTree(child), /died of SIGKILL, so the end of its tree cannot be established/);
  } finally {
    child.stdin.end();
  }
  await closed;
});

test('an aborted run ends its tree through the helper and rejects', () =>
  withTree(async (dir, members, _remember, track) => {
    const script = join(dir, 'abort.mjs');
    writeFileSync(script, treeScript(dir, { out: 'ignore', after: "console.log('ready'); setInterval(() => {}, 1000);" }));
    const controller = new AbortController();
    await assert.rejects(
      runTree(process.execPath, [script], {
        label: 'abort lane',
        cwd: dir,
        deadlineMs: 60_000,
        signal: controller.signal,
        onSpawn: (child) => {
          track(child);
          child.stdout.once('data', () => controller.abort());
        },
      }),
      { code: 'ABORT_ERR', message: /abort lane was aborted and its tree ended/ },
    );
    assert.equal(members().length, 2);
    await assertTreeEnded(dir, members());
    await assert.rejects(runTree(process.execPath, ['-e', '0'], { label: 'late', deadlineMs: 30_000, signal: controller.signal }), { code: 'ABORT_ERR' });
  }));

test('a callback that throws after the start ends the started tree and rejects', async () => {
  let started;
  await assert.rejects(
    runTree(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      label: 'throwing lane',
      deadlineMs: 60_000,
      onSpawn: (child) => {
        started = child;
        throw new Error('callback failure');
      },
    }),
    /throwing lane: the onSpawn callback threw: callback failure \(ended: /,
  );
  assert.ok(started.exitCode !== null || started.signalCode !== null, 'the helper has exited, so it ended its tree');
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

// Not `node -e` with fstat(3): Node's own event loop owns a descriptor near 3 of its own, which would read as "open". `sh` opens
// none: `: <&3` succeeds only if descriptor 3 is open in the shell it runs in, and the nested `sh` is a descendant of the program.
const FD3_OPEN_IN_DESCENDANT = 'if sh -c ": <&3" 2>/dev/null; then echo open; else echo closed; fi';

test('the program and its descendants do not inherit the parent channel', { skip: WINDOWS && 'POSIX descriptors' }, async () => {
  const done = await runTree('sh', ['-c', FD3_OPEN_IN_DESCENDANT], { label: 'fd3', deadlineMs: 30_000 });
  assert.equal(done.stdout.trim(), 'closed');
});

test('the descriptor check does see an inherited descriptor 3 (the check is not vacuous)', { skip: WINDOWS && 'POSIX descriptors' }, () => {
  const seen = spawnSync('sh', ['-c', FD3_OPEN_IN_DESCENDANT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 30_000 });
  assert.equal(seen.stdout.trim(), 'open');
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
  const stuck = Object.assign(new EventEmitter(), { pid: 2_000_000_000, exitCode: null, signalCode: null, kill: () => true, stdio: [null, null, null, { end() {} }] });
  await assert.rejects(endTree(stuck, { deadlineMs: 50 }), /tree helper of pid 2000000000 did not exit within 50ms/);
});

test('a process is identified by its pid together with its start time: the same process answers the same value twice, none answers null', async () => {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    // Two processes may share a start time (POSIX lstart has one-second resolution); the pair with the pid is what differs.
    const mine = await startTimeOf(sleeper.pid);
    assert.ok(mine);
    assert.equal(await startTimeOf(sleeper.pid), mine);
    assert.notDeepEqual({ pid: sleeper.pid, start: mine }, { pid: process.pid, start: await startTimeOf(process.pid) });
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
    // macOS has no verified handle: it answers 4 for every directory and ends nothing.
    assert.equal(refused.status, process.platform === 'darwin' ? 4 : 3, refused.stderr);
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
// A path is data to the process queries, never PowerShell: `$(...)` would be evaluated and a backtick would escape the next
// character if either were put into a double-quoted script string.
for (const name of ['a$(throw 1)', 'b`n`$x']) {
  test(`a directory named ${name} is queried as it is written`, async () => {
    const dir = mkdtempSync(join(tmpdir(), name));
    const exe = join(dir, WINDOWS ? 'odd.exe' : 'odd');
    copyFileSync(process.execPath, exe);
    const odd = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      assert.ok((await processesInside(dir)).some(({ pid }) => pid === odd.pid), `pid ${odd.pid} is found inside ${dir}`);
      assert.ok((await pidsOfExecutable(exe)).includes(odd.pid), `pid ${odd.pid} is found running ${exe}`);
    } finally {
      odd.kill();
      await exitOf(odd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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