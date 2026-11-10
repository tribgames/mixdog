import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { worktreePreparationNote } from './preparation-report.mjs';
import { WORKTREE_SETUP_ELISION, createOutputWindow, runWorktreeSetupCommands } from './setup-commands.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-setup-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** The command lines as setup entries run in `cwd`. */
function at(cwd, commands) {
  return commands.map((command) => ({ command, cwd }));
}

/** A shell command line running `source` as a node script in the cwd. */
function node(name, source) {
  const file = join(root, `${name}.cjs`);
  writeFileSync(file, source);
  return `"${process.execPath}" "${file}"`;
}

test('commands run in order in the worktree and report their output', async () => {
  const cwd = mkdtempSync(join(root, 'ok-'));
  const events = [];
  const report = await runWorktreeSetupCommands({
    commands: at(cwd, [
      node('first', "require('fs').writeFileSync('first.txt', 'one'); console.log('installed');"),
      node('second', "console.log(require('fs').readFileSync('first.txt', 'utf8') + ' two');"),
    ]),
    onProgress: (event) => events.push(event),
  });
  assert.equal(report.status, 'completed');
  assert.deepEqual(
    report.steps.map((step) => [step.status, step.exitCode, step.output.trim()]),
    [
      ['completed', 0, 'installed'],
      ['completed', 0, 'one two'],
    ]
  );
  assert.deepEqual(
    events.filter((event) => !event.final && event.output === '').map((event) => event.index),
    [0, 1],
    'each command announces its start'
  );
  assert.equal(events.at(-1).final, true);
  assert.equal(events.at(-1).status, 'completed');
});

test('a failing command ends the run with its exit code and output, and later commands never run', async () => {
  const cwd = mkdtempSync(join(root, 'fail-'));
  const report = await runWorktreeSetupCommands({
    commands: at(cwd, [
      node('fails', "console.error('missing dependency'); process.exit(3);"),
      node('after', "require('fs').writeFileSync('after.txt', 'ran');"),
    ]),
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].exitCode, 3);
  assert.match(report.steps[0].output, /missing dependency/);
  assert.equal(existsSync(join(cwd, 'after.txt')), false);
});

test('the commands a failure leaves unrun are reported, and the note lists each as skipped with its folder', async () => {
  const cwd = mkdtempSync(join(root, 'pending-'));
  const later = [
    { command: node('web', "console.log('web');"), cwd: join(cwd, 'web'), label: 'npm (web)' },
    { command: node('api', "console.log('api');"), cwd: join(cwd, 'api'), label: 'uv (api)' },
  ];
  const report = await runWorktreeSetupCommands({
    commands: [{ command: node('broken', 'process.exit(2);'), cwd, label: 'npm (project root)' }, ...later],
  });
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.pending, later);
  const note = worktreePreparationNote({ root: cwd, installs: report });
  for (const step of later) {
    assert.ok(
      note.includes(`Skipped (not run after the stop): ${step.label} — run \`${step.command}\` in ${step.cwd}`),
      note
    );
  }
});

test('a command env sets and removes variables for that command only', async () => {
  const cwd = mkdtempSync(join(root, 'env-'));
  const saved = process.env.MIXDOG_SETUP_INHERITED;
  process.env.MIXDOG_SETUP_INHERITED = 'parent';
  try {
    const report = await runWorktreeSetupCommands({
      commands: [
        {
          command: node(
            'env',
            'console.log(JSON.stringify([process.env.MIXDOG_SETUP_INHERITED ?? null, process.env.MIXDOG_SETUP_SET ?? null]));'
          ),
          cwd,
          env: { MIXDOG_SETUP_INHERITED: null, MIXDOG_SETUP_SET: 'yes' },
        },
      ],
    });
    assert.deepEqual(JSON.parse(report.steps[0].output), [null, 'yes']);
    assert.equal(process.env.MIXDOG_SETUP_INHERITED, 'parent');
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_SETUP_INHERITED;
    else process.env.MIXDOG_SETUP_INHERITED = saved;
  }
});

test('a command over the timeout is killed and reported as timed out', async () => {
  const cwd = mkdtempSync(join(root, 'timeout-'));
  const started = Date.now();
  const report = await runWorktreeSetupCommands({
    commands: at(cwd, [node('hangs', "setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 3000);")]),
    timeoutMs: 300,
  });
  assert.equal(report.status, 'timed-out');
  assert.equal(report.steps[0].status, 'timed-out');
  assert.ok(Date.now() - started < 2500, 'the run ends at the timeout, not when the command would');
  await delay(3500);
  assert.equal(existsSync(join(cwd, 'late.txt')), false, 'the killed command never finished');
});

test('an aborted signal cancels the running command and skips the rest', async () => {
  const cwd = mkdtempSync(join(root, 'cancel-'));
  const controller = new AbortController();
  const run = runWorktreeSetupCommands({
    commands: at(cwd, [
      node('slow', "console.log('started'); setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 3000);"),
      node('next', "require('fs').writeFileSync('next.txt', 'x');"),
    ]),
    signal: controller.signal,
    onProgress: (event) => {
      if (!event.final && event.output.includes('started')) controller.abort();
    },
  });
  const report = await run;
  assert.equal(report.status, 'cancelled');
  assert.equal(report.steps.length, 1);
  await delay(3500);
  assert.equal(existsSync(join(cwd, 'late.txt')), false);
  assert.equal(existsSync(join(cwd, 'next.txt')), false);
});

test('output beyond the cap keeps its start and end and drops the middle', async () => {
  const cwd = mkdtempSync(join(root, 'large-'));
  const report = await runWorktreeSetupCommands({
    commands: at(cwd, [
      node('loud', "process.stdout.write('BEGIN' + 'x'.repeat(200000) + 'END', () => process.exit(0));"),
    ]),
    outputBytes: 1024,
  });
  const [step] = report.steps;
  assert.equal(step.status, 'completed');
  assert.equal(step.truncated, true);
  assert.ok(step.output.startsWith('BEGIN'));
  assert.ok(step.output.endsWith('END'));
  assert.ok(step.output.includes(WORKTREE_SETUP_ELISION));
  assert.ok(Buffer.byteLength(step.output) <= 1024 + Buffer.byteLength(WORKTREE_SETUP_ELISION));

  const window = createOutputWindow(8);
  window.append('1234');
  window.append('5678');
  assert.equal(window.truncated, false);
  assert.equal(window.text(), '12345678', 'output within the cap is kept whole');
  window.append('9');
  assert.equal(window.text(), `1234${WORKTREE_SETUP_ELISION}6789`);
});
