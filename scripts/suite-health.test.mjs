import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildReport,
  DISPLAY_SUITES,
  failureParts,
  failureTail,
  selectSuiteScripts,
  sweepCommand,
  sweepEnv,
  TEST_PLAINTEXT_SAFE_STORAGE_ENV,
  WORKSPACES,
} from './suite-health.mjs';

test('a failed entry keeps its failure-summary lines even under a long stderr', () => {
  const stdout = [
    'noise',
    '✖ broken test (3ms)',
    '[failure-summary] 1 failed, 0 flaky',
    '[failure-summary] FAILED a.test.mjs > t',
  ];
  const stderr = Array.from({ length: 60 }, (_, i) => `cargo line ${i}`);
  const tail = failureTail({ stdout: stdout.join('\n'), stderr: stderr.join('\n'), status: 1 });
  assert.match(tail, /^exit 1\n/);
  assert.match(tail, /\[failure-summary\] FAILED a\.test\.mjs > t/);
  assert.match(tail, /✖ broken test/);
  assert.match(failureTail({ stdout: '', stderr: '', status: null, signal: 'SIGKILL' }), /exit none, signal SIGKILL/);
});

test('every failed-test line is kept past 40 failures and truncated tails say so', () => {
  const names = Array.from({ length: 60 }, (_, i) => `[failure-summary] FAILED f${i}.test.mjs > t`);
  const stderr = Array.from({ length: 60 }, (_, i) => `cargo line ${i}`).join('\n');
  const tail = failureTail({ stdout: names.join('\n'), stderr, status: 1 });
  for (const name of names) assert.ok(tail.includes(name), name);
  assert.match(tail, /\[stderr truncated: last 25 of 60 lines\]/);
  assert.match(tail, /\[stdout truncated: last 25 of 60 lines\]/);
});

test('an oversized report fits the issue limit: tails go first, then failure lines, with a stated omission', () => {
  const runUrl = 'https://github.com/o/r/actions/runs/1';
  const make = (count, tailLines) =>
    failureParts({
      stdout: Array.from(
        { length: count },
        (_, i) => `[failure-summary] FAILED big${i}.test.mjs > ${'x'.repeat(80)}`
      ).join('\n'),
      stderr: Array.from({ length: tailLines }, (_, i) => `${'y'.repeat(4000)}${i}`).join('\n'),
      status: 1,
    });
  const build = (parts) =>
    buildReport({
      checked: 'now',
      runUrl,
      reportLines: ['- big: FAILED (1s)'],
      failures: [{ title: '- big: FAILED (1s)', parts }],
    });

  // Tails alone overflow: every failure name stays, the tails are dropped and said so.
  const tailsOver = build(make(40, 40));
  assert.ok(tailsOver.length <= 65_536 && tailsOver.length > 1000);
  assert.ok(tailsOver.includes('big39.test.mjs'));
  assert.match(tailsOver, /tails omitted/);
  assert.doesNotMatch(tailsOver, /yyyy/);

  // Names alone overflow: the tail of the list is cut and counted, never silently.
  const namesOver = build(make(2000, 5));
  assert.ok(namesOver.length <= 65_536);
  assert.ok(namesOver.includes('big0.test.mjs'));
  assert.match(
    namesOver,
    /\d+ more failure lines omitted — see the workflow log: https:\/\/github\.com\/o\/r\/actions\/runs\/1/
  );

  // A small report is untouched.
  assert.doesNotMatch(build(make(3, 2)), /omitted/);
});

test('Electron suites run under a virtual display on Linux only, and stay in the sweep', () => {
  const desktop = WORKSPACES.find((ws) => ws.dir === 'apps/desktop');
  const pkg = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
  const swept = selectSuiteScripts(pkg.scripts, desktop.exclusions);
  for (const name of DISPLAY_SUITES) {
    assert.ok(swept.includes(name), `${name} must be swept`);
    const [command, args] = sweepCommand(desktop, name, 'linux');
    assert.equal(command, 'xvfb-run');
    assert.deepEqual(args, [
      '-a',
      '--server-args=-screen 0 1440x900x24',
      'npm',
      'run',
      name,
      '--prefix',
      'apps/desktop',
    ]);
    assert.equal(sweepCommand(desktop, name, 'win32')[0], 'npm.cmd');
    // Only the Linux sweep of these entries opts the test harness into plaintext safeStorage.
    assert.equal(sweepEnv(desktop, name, 'linux', { PATH: 'p' })[TEST_PLAINTEXT_SAFE_STORAGE_ENV], '1');
    assert.equal(sweepEnv(desktop, name, 'linux', { PATH: 'p' }).PATH, 'p');
    assert.equal(sweepEnv(desktop, name, 'win32', { PATH: 'p' })[TEST_PLAINTEXT_SAFE_STORAGE_ENV], undefined);
  }
  assert.equal(sweepCommand({ dir: '.' }, 'smoke', 'linux')[0], 'npm');
  assert.equal(sweepEnv(desktop, 'test', 'linux', {})[TEST_PLAINTEXT_SAFE_STORAGE_ENV], undefined);
});

test('selection takes every test:/smoke: script and honors reasoned exclusions', () => {
  const scripts = {
    'test:a': '',
    smoke: '',
    'smoke:b': '',
    'bench:x': '',
    build: '',
    'test:skip': '',
  };
  assert.deepEqual(selectSuiteScripts(scripts, { 'test:skip': 'reason' }), ['test:a', 'smoke', 'smoke:b']);
});

test('a stale exclusion fails closed instead of silently shrinking the sweep', () => {
  assert.throws(() => selectSuiteScripts({ 'test:a': '' }, { 'test:gone': 'reason' }), /stale exclusions/);
});

test('the configured workspaces select real, non-empty suite catalogs', () => {
  for (const ws of WORKSPACES) {
    const pkgUrl = new URL(ws.dir === '.' ? '../package.json' : `../${ws.dir}/package.json`, import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
    const names = selectSuiteScripts(pkg.scripts || {}, ws.exclusions);
    assert.ok(names.length > 0, `${ws.dir} sweep must not be empty`);
    for (const excluded of Object.keys(ws.exclusions)) {
      assert.ok(!names.includes(excluded), `${excluded} must stay excluded`);
    }
  }
});
