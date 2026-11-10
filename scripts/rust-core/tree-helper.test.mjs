// The tree helper (scripts/rust-core/tree-helper) driven on its own: signals sent to it, descendants that left its group,
// what its result record says, and a reader meeting a partial record. process-tree.test.mjs covers the library around it.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endTree, runTree, spawnTree } from './lib/process-tree.mjs';
import { assertTreeEnded, leakGuard } from './lib/process-probe.mjs';

const PROBE = new URL('./lib/process-probe.mjs', import.meta.url).href;
const WINDOWS = process.platform === 'win32';
const DARWIN = process.platform === 'darwin';
// Every descendant a test starts expires by itself (leakGuard) for the case that the behaviour under test fails; a guard
// that fired leaves a marker that fails the test's check, so it never stands in for the end of the tree. macOS cannot find
// an escaped descendant, so there the one such descendant expires within seconds and is not checked.
const LIFE_MS = 90_000;

const NODE_HOLD = (dir, lifeMs, extra = '') => `${extra}${leakGuard(dir, lifeMs)} setInterval(() => {}, 1000)`;

// The directory of a test and the recorded members (pid with the start time first seen); `track(child)` registers a started
// helper, which the last resort asks to end its tree when the behaviour under test failed and left the run half-ended.
async function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'tree-helper-'));
  const tracked = [];
  const members = () => JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
  try {
    await body(dir, members, (child) => tracked.push(child));
  } finally {
    const failures = [];
    for (const child of tracked) await endTree(child).catch((error) => failures.push(error.message));
    rmSync(dir, { recursive: true, force: true });
    if (failures.length) throw new Error(`last-resort end of a tracked helper failed: ${failures.join('; ')}`);
  }
}

const within = (promise, what, ms = 60_000) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};
const closeOf = (child) => within(new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal }))), `the close of helper ${child.pid}`);
const firstData = (stream, what) => within(new Promise((resolveData) => stream.once('data', resolveData)), what);

// The program: starts a grandchild that depends on nothing (stdio ignored, no pipe), records both with their start times, runs
// `after`. It carries the same leak guard as its grandchild.
const programScript = (dir, after) => `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startTimeOf } from ${JSON.stringify(PROBE)};
${leakGuard(dir, LIFE_MS)}
const gc = spawn(process.execPath, ['-e', ${JSON.stringify(NODE_HOLD(dir, LIFE_MS))}], { stdio: 'ignore', detached: ${WINDOWS} });
writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify(await Promise.all([process.pid, gc.pid].map(async (pid) => ({ pid, start: await startTimeOf(pid) })))));
${after}
`;

for (const [name, number] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]]) {
  test(`${name} sent to the helper ends the program and its grandchild, exits ${128 + number} and writes no report`, { skip: WINDOWS && 'POSIX signals' }, () =>
    withDir(async (dir, members) => {
      const script = join(dir, 'tree.mjs');
      writeFileSync(script, programScript(dir, "console.log('ready'); setInterval(() => {}, 1000);"));
      const child = spawnTree(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.on('error', () => {});
      const closed = closeOf(child);
      await firstData(child.stdout, 'the program reporting that it started');
      assert.equal(members().length, 2);
      child.kill(name);
      assert.deepEqual(await closed, { code: 128 + number, signal: null });
      assert.equal(child.treeOutcome(), null, 'no completion record: the run did not finish');
      await assertTreeEnded(dir, members());
    }));
}

// The program signals its helper and exits at once: whichever of the two the helper sees first, the signal reached it before
// it published, so there is no record and the exit is 143. (Which one comes first is not controlled here; the order in which
// the exit is seen first and the signal is caught during the end of the tree is the unit test
// a_signal_caught_before_publication_withholds_the_record.)
test('a SIGTERM that reaches the helper as its program exits withholds the report: exit 143', { skip: WINDOWS && 'POSIX signals' }, async () => {
  const child = spawnTree(process.execPath, ['-e', 'process.kill(process.ppid, "SIGTERM"); process.exit(0)'], { stdio: 'ignore' });
  child.on('error', () => {});
  assert.deepEqual(await closeOf(child), { code: 143, signal: null });
  assert.equal(child.treeOutcome(), null);
});

// What the former session test relied on: its grandchild left when the pipe to its starter closed, so it passed with an
// unowned tree. This one depends on nothing: its own session, SIGHUP ignored, a starter that exits at once.
test('a descendant that left the group, ignores SIGHUP and outlives its starter is ended and named (Linux), reported unfindable (macOS)', () =>
  withDir(async (dir, members, track) => {
    const script = join(dir, 'escape.mjs');
    const life = DARWIN ? 8000 : LIFE_MS;
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startTimeOf } from ${JSON.stringify(PROBE)};
const escaped = spawn(process.execPath, ['-e', ${JSON.stringify(NODE_HOLD(dir, life, 'process.on("SIGHUP", () => {}); '))}], { stdio: 'ignore', detached: true });
writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify(await Promise.all([process.pid, escaped.pid].map(async (pid) => ({ pid, start: await startTimeOf(pid) })))));
process.exit(0);
`,
    );
    const done = await runTree(process.execPath, [script], { label: 'escaped lane', cwd: dir, deadlineMs: 60_000, onSpawn: track });
    assert.equal(done.status, 0);
    const [, escaped] = members();
    if (DARWIN) {
      assert.equal(done.escapes, 'undetectable', 'macOS cannot adopt an escaped descendant and must say so');
      assert.deepEqual(done.escapedEnded, []);
      return;
    }
    assert.equal(done.escapes, 'checked');
    if (process.platform === 'linux') assert.deepEqual(done.escapedEnded, [escaped.pid], 'adopted through the subreaper and ended by the helper');
    await assertTreeEnded(dir, members());
  }));

// The members left in the program's group are signalled when it exits; the run must return only once they are gone, which the
// single process query right after it checks. Linux reaps each as the helper's own adopted child; macOS waits for the group to
// be empty (item: a signal sent is not a member ended). Several members make one still dying at the query likely if that
// wait were missing.
test('a program that exits leaving eight members in its group: every one is gone when the run returns', () =>
  withDir(async (dir, members, track) => {
    const script = join(dir, 'many.mjs');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startTimeOf } from ${JSON.stringify(PROBE)};
const kids = Array.from({ length: 8 }, () => spawn(process.execPath, ['-e', ${JSON.stringify(NODE_HOLD(dir, LIFE_MS))}], { stdio: 'ignore', detached: ${WINDOWS} }));
writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify(await Promise.all([process.pid, ...kids.map((k) => k.pid)].map(async (pid) => ({ pid, start: await startTimeOf(pid) })))));
process.exit(0);
`,
    );
    const done = await runTree(process.execPath, [script], { label: 'eight members lane', cwd: dir, deadlineMs: 60_000, onSpawn: track });
    assert.equal(done.status, 0);
    assert.equal(members().length, 9);
    await assertTreeEnded(dir, members());
  }));

// S (the program) starts P, P starts G and exits, G starts H only once P is gone (end-of-file on the pipe P held). H must
// still be in the tree: Windows job membership and the POSIX group are inherited by a process started after its ancestor died.
test('a grandchild started after its parent exited is still in the tree', () =>
  withDir(async (dir, members, track) => {
    const hold = JSON.stringify(NODE_HOLD(dir, LIFE_MS));
    const grandchild = join(dir, 'g.mjs');
    writeFileSync(
      grandchild,
      `import { spawn } from 'node:child_process';
process.stdin.resume();
process.stdin.on('end', () => {
  const h = spawn(process.execPath, ['-e', ${hold}], { stdio: 'ignore', detached: ${WINDOWS} });
  console.log(JSON.stringify({ g: process.pid, h: h.pid }));
});
${leakGuard(dir, LIFE_MS)}
`,
    );
    const parent = join(dir, 'p.mjs');
    writeFileSync(
      parent,
      `import { spawn } from 'node:child_process';
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: ['pipe', 'inherit', 'inherit'], detached: ${WINDOWS} });
process.exit(0);
`,
    );
    const program = join(dir, 's.mjs');
    writeFileSync(
      program,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { startTimeOf } from ${JSON.stringify(PROBE)};
const p = spawn(process.execPath, [${JSON.stringify(parent)}], { stdio: ['ignore', 'pipe', 'inherit'], detached: ${WINDOWS} });
let text = '';
for await (const chunk of p.stdout) {
  text += chunk;
  const line = text.split('\\n').find((l) => l.startsWith('{'));
  if (!line) continue;
  const { g, h } = JSON.parse(line);
  writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify(await Promise.all([process.pid, g, h].map(async (pid) => ({ pid, start: await startTimeOf(pid) })))));
  break;
}
process.exit(0);
`,
    );
    const done = await runTree(process.execPath, [program], { label: 'late grandchild lane', cwd: dir, deadlineMs: 60_000, onSpawn: track });
    assert.equal(done.status, 0);
    assert.equal(members().length, 3);
    await assertTreeEnded(dir, members());
  }));

// The record, read through the library: a launch failure is the record's, never an exit code that a program could also use.
const runOnce = (program, args) =>
  new Promise((resolveRun) => {
    const child = spawnTree(program, args, { stdio: 'ignore' });
    const errors = [];
    child.on('error', (error) => errors.push(error));
    child.once('close', (code, signal) => {
      let outcome;
      try {
        outcome = child.treeOutcome();
      } catch (error) {
        outcome = { thrown: error.message };
      }
      resolveRun({ code, signal, outcome, errors });
    });
  }).then((result) => result);

test('a program that is not there is a launch failure in the record (ENOENT, helper exit 127)', async () => {
  const run = await within(runOnce('no-such-program-anywhere', []), 'the helper finishing');
  assert.equal(run.outcome.launch, 'ENOENT');
  assert.equal(run.code, 127);
  assert.equal(run.errors[0]?.code, 'ENOENT');
});

test('a file that cannot be executed is a launch failure in the record (EACCES)', { skip: WINDOWS && 'POSIX modes' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-helper-eacces-'));
  try {
    const file = join(dir, 'not-executable');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o644);
    const run = await within(runOnce(file, []), 'the helper finishing');
    assert.equal(run.outcome.launch, 'EACCES');
    assert.equal(run.code, 127);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const code of [125, 126, 127]) {
  test(`a program that exits ${code} is not a launch failure: launch null in the record, the exit code unchanged`, async () => {
    const run = await within(runOnce(process.execPath, ['-e', `process.exit(${code})`]), 'the helper finishing');
    assert.equal(run.outcome.launch, null);
    assert.equal(run.outcome.failure, null);
    assert.equal(run.code, code);
    assert.deepEqual(run.errors, []);
  });
}

test('an NTSTATUS exit arrives as it is, with no signal and no launch failure in the record', { skip: !WINDOWS && 'Windows status codes' }, async () => {
  const run = await within(runOnce(process.execPath, ['-e', 'process.exit(0xC0000005)']), 'the helper finishing');
  assert.equal(run.code, 0xc0000005);
  assert.equal(run.outcome.launch, null);
  assert.equal(run.outcome.signal, null);
});

// What the reader finds at the result path of a helper that published nothing (it is killed here, so the planted file stays):
// a file cut short, a record without its completion member, and a complete record of another run (what an earlier run killed
// before it published, or still going, leaves at the same path) are each an error, never this run's outcome.
const COMPLETE_OTHER_RUN = '{"run":"an-earlier-run","launch":null,"signal":null,"escapes":"checked","escaped_ended":[],"failure":null,"complete":true}';
test('a partial result file, or a complete one of another run, is an error for the reader', async () => {
  for (const [planted, expected] of [['{"run":"x","launch":null,"sig', /incomplete/], ['{"run":"x","launch":null,"signal":null}', /no completion record/], [COMPLETE_OTHER_RUN, /is the record of run "an-earlier-run", not of this run/]]) {
    // The program ends itself when its stdin closes: a killed POSIX helper ends nothing.
    const child = spawnTree(process.execPath, ['-e', 'console.log("started"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    const errors = [];
    child.on('error', (error) => errors.push(error));
    const closed = closeOf(child);
    try {
      await firstData(child.stdout, 'the program starting');
      writeFileSync(child.spawnargs[1], planted);
      child.kill('SIGKILL');
    } finally {
      child.stdin.end();
    }
    await closed;
    assert.throws(() => child.treeOutcome(), expected);
    assert.equal(errors[0]?.code, 'ETREEHELPER');
  }
});
