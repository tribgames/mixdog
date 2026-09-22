import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFailureRecorder, failureRecord } from './lib/test-failure-records.mjs';
import { classifyRerunOutcomes, formatFailureSummary, policyLine, SUMMARY_TAG } from './lib/test-failure-summary.mjs';
import { discoverTestFiles, laneOf, laneSelected, parseArgs, selectTestFiles, USAGE } from './test.mjs';

const runnerUrl = new URL('./test.mjs', import.meta.url);
const runnerPath = fileURLToPath(runnerUrl);
const summaryReporterUrl = new URL('./lib/test-summary-reporter.mjs', import.meta.url).href;

async function fixture(t, entries) {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-test-runner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(entries)) {
    const path = join(cwd, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return cwd;
}

function runNode(cwd, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('lane names are suffix-based, case-sensitive, and default to fast', () => {
  assert.equal(laneOf('src/a.test.mjs'), 'fast');
  assert.equal(laneOf('scripts/a-test.mjs'), 'fast');
  assert.equal(laneOf('src/a.slow.test.mjs'), 'slow');
  assert.equal(laneOf('scripts/a.live.test.mjs'), 'live');
  assert.equal(laneOf('src/a.electron.test.mjs'), 'electron');
  assert.equal(laneOf('src/a.LIVE.test.mjs'), 'fast');
  assert.equal(laneOf('src/electron/a.test.mjs'), 'fast');
  assert.equal(laneOf('src/slow/a.test.mjs'), 'fast');
});

test('the electron lane rides the default lane and is dropped only by an explicit exclusion', () => {
  // Electron and window-capture tests cannot run twice at once, so they own a
  // lane — but a plain run must keep covering them.
  assert.equal(laneSelected('fast', 'electron'), true);
  assert.equal(laneSelected('fast', 'slow'), false);
  assert.equal(laneSelected('fast', 'live'), false);
  assert.equal(laneSelected('electron', 'electron'), true);
  assert.equal(laneSelected('electron', 'fast'), false);
  assert.equal(laneSelected('all', 'electron'), true);
  const files = ['src/a.test.mjs', 'src/overlay.electron.test.mjs', 'src/z.slow.test.mjs'];
  assert.deepEqual(selectTestFiles(files, parseArgs([])), ['src/a.test.mjs', 'src/overlay.electron.test.mjs']);
  assert.deepEqual(selectTestFiles(files, parseArgs(['--exclude-lane', 'electron'])), ['src/a.test.mjs']);
  assert.deepEqual(selectTestFiles(files, parseArgs(['--lane=electron'])), ['src/overlay.electron.test.mjs']);
  assert.deepEqual(selectTestFiles(files, parseArgs(['--lane=all', '--exclude-lane=electron', '--exclude-lane=slow'])), [
    'src/a.test.mjs',
  ]);
  assert.throws(() => parseArgs(['--exclude-lane=nightly']), {
    message: 'unknown excluded lane "nightly" (fast|slow|live|electron)',
  });
  assert.throws(() => parseArgs(['--exclude-lane=all']), {
    message: 'unknown excluded lane "all" (fast|slow|live|electron)',
  });
});

test('arguments preserve defaults, flag forwarding, last lane, and normalized filters', () => {
  assert.deepEqual(parseArgs([]), { lane: 'fast', list: false, nodeArgs: [], filters: [] });
  assert.deepEqual(
    parseArgs([
      '--lane',
      'slow',
      '--lane=all',
      '--list',
      '--import',
      'setup.mjs',
      '--import=other.mjs',
      '--test-name-pattern=chosen',
      '--test-only',
      'src\\nested',
      'scripts/example',
    ]),
    {
      lane: 'all',
      list: true,
      nodeArgs: ['--import', 'setup.mjs', '--import=other.mjs', '--test-name-pattern=chosen', '--test-only'],
      filters: ['src/nested', 'scripts/example'],
    }
  );
  assert.throws(() => parseArgs(['--lane=nightly']), {
    message: 'unknown lane "nightly" (fast|slow|live|electron|all)',
  });
  assert.throws(() => parseArgs(['--lane']), {
    message: 'unknown lane "undefined" (fast|slow|live|electron|all)',
  });
});

test('re-run, exclusion and help flags stay opt-in and reject unusable values', () => {
  // An absent flag must leave the parsed options untouched, so nothing
  // downstream can branch on re-runs or lane exclusion by accident.
  assert.deepEqual(parseArgs([]), { lane: 'fast', list: false, nodeArgs: [], filters: [] });
  assert.equal(parseArgs(['--rerun-failed', '3']).rerunFailed, 3);
  assert.equal(parseArgs(['--rerun-failed=0']).rerunFailed, 0);
  assert.deepEqual(parseArgs(['--exclude-lane=electron', '--exclude-lane', 'slow']).excludeLanes, [
    'electron',
    'slow',
  ]);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.deepEqual(parseArgs(['--rerun-failed', '2', 'src/a']).filters, ['src/a']);
  for (const value of ['x', '-1', '1.5', '']) {
    assert.throws(() => parseArgs([`--rerun-failed=${value}`]), {
      message: `--rerun-failed requires a non-negative integer (got "${value}")`,
    });
  }
  assert.throws(() => parseArgs(['--rerun-failed']), {
    message: '--rerun-failed requires a non-negative integer (got "undefined")',
  });
});

test('failure records name the failing leaf with its suite path, and skip todo and aggregate events', () => {
  const stacks = new Map();
  const file = join(process.cwd(), 'src', 'sample.test.mjs');
  const relativeFile = 'src/sample.test.mjs';
  assert.equal(failureRecord({ type: 'test:start', data: { name: 'outer suite', nesting: 0, file } }, stacks), null);
  assert.equal(failureRecord({ type: 'test:start', data: { name: 'inner case', nesting: 1, file } }, stacks), null);
  assert.deepEqual(failureRecord({ type: 'test:fail', data: { name: 'inner case', nesting: 1, file } }, stacks), {
    file: relativeFile,
    name: 'outer suite > inner case',
  });
  // The suite repeats its child's failure; only the leaf may be named.
  assert.equal(
    failureRecord(
      {
        type: 'test:fail',
        data: { name: 'outer suite', nesting: 0, file, details: { error: { failureType: 'subtestsFailed' } } },
      },
      stacks
    ),
    null
  );
  // A failing todo does not fail the run, so it is not a failure to report.
  assert.equal(
    failureRecord({ type: 'test:fail', data: { name: 'later', nesting: 0, file, todo: 'pending' } }, stacks),
    null
  );
  assert.equal(failureRecord({ type: 'test:pass', data: { name: 'fine', nesting: 0, file } }, stacks), null);
  // Files run concurrently, so each file keeps its own ancestor stack.
  const other = join(process.cwd(), 'src', 'other.test.mjs');
  failureRecord({ type: 'test:start', data: { name: 'other suite', nesting: 0, file: other } }, stacks);
  assert.deepEqual(failureRecord({ type: 'test:fail', data: { name: 'inner case', nesting: 1, file } }, stacks), {
    file: relativeFile,
    name: 'outer suite > inner case',
  });
  // Without the runner's environment path nothing is recorded, so a direct
  // `node --test` run is unaffected.
  assert.equal(createFailureRecorder('')({ type: 'test:fail', data: { name: 'x', nesting: 0, file } }), undefined);
});

test('re-run classification separates flaky from failed and always states the exit policy', () => {
  const failing = { file: 'src/a.test.mjs', name: 'always fails' };
  const flaky = { file: 'src/b.test.mjs', name: 'load sensitive' };
  assert.deepEqual(classifyRerunOutcomes([failing, flaky]), { failed: [failing, flaky], flaky: [] });
  const outcome = classifyRerunOutcomes(
    [failing, flaky],
    [{ files: ['src/a.test.mjs', 'src/b.test.mjs'], failures: [failing] }]
  );
  assert.deepEqual(outcome, {
    failed: [failing],
    flaky: [{ ...flaky, passedOnAttempt: 1 }],
  });
  // A test that only breaks on a re-run is a failure, never silence.
  const regressed = { file: 'src/c.test.mjs', name: 'broke on rerun' };
  assert.deepEqual(
    classifyRerunOutcomes([failing], [{ files: ['src/a.test.mjs'], failures: [failing, regressed] }]).failed,
    [failing, { ...regressed, firstSeenOnRerun: 1 }]
  );
  // A test that passed once stays flaky even if a later attempt fails again.
  assert.deepEqual(
    classifyRerunOutcomes(
      [failing, flaky],
      [
        { files: ['src/a.test.mjs', 'src/b.test.mjs'], failures: [failing] },
        { files: ['src/a.test.mjs'], failures: [failing, flaky] },
      ]
    ).flaky,
    [{ ...flaky, passedOnAttempt: 1 }]
  );
  const report = formatFailureSummary({ ...outcome, rerunFailed: 2 });
  for (const line of report.trimEnd().split('\n')) assert.ok(line.startsWith(SUMMARY_TAG), line);
  assert.match(report, /1 failed, 1 flaky/);
  assert.match(report, /FAILED src\/a\.test\.mjs > always fails/);
  assert.match(report, /FLAKY src\/b\.test\.mjs > load sensitive \(failed, then passed on re-run 1\/2\)/);
  assert.match(report, /flaky test does not fail the run/);
  assert.equal(formatFailureSummary({}), `${SUMMARY_TAG} 0 failed, 0 flaky (every failed test is named below)\n`);
  assert.match(policyLine(0), /every failure fails the run/);
  assert.match(USAGE, /--rerun-failed <n>/);
  assert.match(USAGE, /does NOT fail the run/);
  assert.match(USAGE, /--exclude-lane electron/);
});

test('discovery covers the package root, src, scripts, lib and deploy, excludes whole directory segments, and sorts paths', async (t) => {
  const cwd = await fixture(t, {
    'src/a.test.mjs': '',
    // apps/relay keeps its suites beside its entry point and in lib/ + deploy/.
    'lib/leg.test.mjs': '',
    'deploy/release.test.mjs': '',
    'src/feature.slow.test.mjs': '',
    'src/feature.live.test.mjs': '',
    'src/fixtures/node_modules-like/kept.test.mjs': '',
    'src/targeted/kept-test.mjs': '',
    'scripts/b-test.mjs': '',
    'scripts/nested/c.test.mjs': '',
    'src/plain.mjs': '',
    'src/noop.test.jsx': '',
    'outside.test.mjs': '',
    'apps/desktop/src/ignored.test.mjs': '',
    'src/node_modules/ignored.test.mjs': '',
    'src/.runtime/ignored.test.mjs': '',
    'src/out/ignored.test.mjs': '',
    'src/dist/ignored.test.mjs': '',
    'src/target/ignored.test.mjs': '',
    'scripts/nested/node_modules/ignored.test.mjs': '',
    'scripts/nested/target/ignored-test.mjs': '',
  });
  assert.deepEqual(await discoverTestFiles(cwd), [
    'deploy/release.test.mjs',
    'lib/leg.test.mjs',
    // The package root is shallow, so a nested workspace package (apps/desktop
    // above) never joins the invoking package's suite.
    'outside.test.mjs',
    'scripts/b-test.mjs',
    'scripts/nested/c.test.mjs',
    'src/a.test.mjs',
    'src/feature.live.test.mjs',
    'src/feature.slow.test.mjs',
    'src/fixtures/node_modules-like/kept.test.mjs',
    'src/targeted/kept-test.mjs',
  ]);
});

test('discovery accepts absent roots and empty workspaces', async (t) => {
  const empty = await fixture(t, {});
  assert.deepEqual(await discoverTestFiles(empty), []);
  const scriptsOnly = await fixture(t, { 'scripts/only-test.mjs': '' });
  assert.deepEqual(await discoverTestFiles(scriptsOnly), ['scripts/only-test.mjs']);
});

test('selection combines lane and OR substring filters without reordering inputs', () => {
  // (electron-lane selection is pinned in its own case above)
  const files = ['src/z.slow.test.mjs', 'scripts/b-test.mjs', 'src/a.live.test.mjs', 'src/c.test.mjs'];
  assert.deepEqual(selectTestFiles(files, parseArgs([])), ['scripts/b-test.mjs', 'src/c.test.mjs']);
  assert.deepEqual(selectTestFiles(files, parseArgs(['--lane=all'])), files);
  assert.deepEqual(selectTestFiles(files, parseArgs(['--lane=all', 'src/a', 'src/z'])), [
    'src/z.slow.test.mjs',
    'src/a.live.test.mjs',
  ]);
  assert.deepEqual(selectTestFiles(files, parseArgs(['--lane=slow', 'scripts', 'src/z'])), ['src/z.slow.test.mjs']);
  assert.deepEqual(selectTestFiles(files, parseArgs(['missing'])), []);
});

test('CLI listing uses its working directory, sorted lanes, filters, and an empty-success result', async (t) => {
  const cwd = await fixture(t, {
    'src/alpha.test.mjs': '',
    'src/beta.live.test.mjs': '',
    'src/omega.slow.test.mjs': '',
    'src/overlay.electron.test.mjs': '',
    'scripts/zeta-test.mjs': '',
  });
  const fast = runNode(cwd, [runnerPath, '--list']);
  assert.equal(fast.status, 0);
  // The default lane keeps covering the electron files, labelled as their own
  // lane so a concurrent run knows what to exclude.
  assert.equal(
    fast.stdout,
    'fast  scripts/zeta-test.mjs\nfast  src/alpha.test.mjs\nelectron src/overlay.electron.test.mjs\n'
  );
  assert.equal(fast.stderr, '');
  const withoutElectron = runNode(cwd, [runnerPath, '--exclude-lane', 'electron', '--list']);
  assert.equal(withoutElectron.status, 0);
  assert.equal(withoutElectron.stdout, 'fast  scripts/zeta-test.mjs\nfast  src/alpha.test.mjs\n');
  const electronOnly = runNode(cwd, [runnerPath, '--lane=electron', '--list']);
  assert.equal(electronOnly.status, 0);
  assert.equal(electronOnly.stdout, 'electron src/overlay.electron.test.mjs\n');
  const help = runNode(cwd, [runnerPath, '--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, `${USAGE}\n`);
  assert.equal(help.stderr, '');
  const all = runNode(cwd, [runnerPath, '--lane=all', '--list']);
  assert.equal(all.status, 0);
  assert.equal(
    all.stdout,
    'fast  scripts/zeta-test.mjs\nfast  src/alpha.test.mjs\nlive  src/beta.live.test.mjs\nslow  src/omega.slow.test.mjs\nelectron src/overlay.electron.test.mjs\n'
  );
  const filtered = runNode(cwd, [runnerPath, '--lane', 'all', '--list', 'omega', 'zeta']);
  assert.equal(filtered.status, 0);
  assert.equal(filtered.stdout, 'fast  scripts/zeta-test.mjs\nslow  src/omega.slow.test.mjs\n');
  const empty = runNode(cwd, [runnerPath, '--list', 'missing']);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
  assert.equal(empty.stderr, '');
});

test('CLI argument and empty-selection errors retain their messages, streams, and exit status', async (t) => {
  const cwd = await fixture(t, {});
  const empty = runNode(cwd, [runnerPath]);
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, '');
  assert.equal(empty.stderr, 'no fast test files match (everything)\n');
  const filtered = runNode(cwd, [runnerPath, '--lane=slow', 'missing']);
  assert.equal(filtered.status, 1);
  assert.equal(filtered.stdout, '');
  assert.equal(filtered.stderr, 'no slow test files match missing\n');
  const invalid = runNode(cwd, [runnerPath, '--lane=nightly', '--list']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /unknown lane "nightly" \(fast\|slow\|live\|electron\|all\)/);
  const invalidRerun = runNode(cwd, [runnerPath, '--rerun-failed=x']);
  assert.equal(invalidRerun.status, 1);
  assert.equal(invalidRerun.stdout, '');
  assert.match(invalidRerun.stderr, /--rerun-failed requires a non-negative integer \(got "x"\)/);
});

test('CLI spawn preserves exact flags, reporters, selected paths, stdio, and child exit mapping', async (t) => {
  const cwd = await fixture(t, {
    'scripts/fast-test.mjs': '',
    'src/omega.slow.test.mjs': '',
  });
  const probe = `
    import { mock } from 'node:test';
    const { runnerPath, runnerUrl, code, signal } = JSON.parse(process.argv[1]);
    mock.module('node:child_process', {
      namedExports: {
        spawn(executable, args, options) {
          return {
            on(event, listener) {
              if (event !== 'exit') return;
              const summary = {
                executable,
                args,
                stdio: options.stdio,
                // The whole parent environment is inherited; the runner only
                // adds where this spawn records its failures.
                inheritsEnvironment: Object.keys(process.env).every(
                  (key) => key === 'MIXDOG_TEST_FAILURE_RECORDS' || options.env[key] === process.env[key]
                ),
                failureRecords: options.env.MIXDOG_TEST_FAILURE_RECORDS,
                event,
              };
              process.stdout.write(JSON.stringify(summary) + '\\n');
              listener(code, signal);
            }
          };
        }
      }
    });
    process.argv = [
      process.execPath, runnerPath, '--lane=slow',
      '--import', 'setup.mjs', '--test-only', 'src/omega'
    ];
    await import(runnerUrl);
  `;
  for (const [code, signal, expectedStatus] of [
    [0, null, 0],
    [7, null, 7],
    [null, 'SIGTERM', 1],
    [null, null, 0],
  ]) {
    const result = runNode(cwd, [
      '--experimental-test-module-mocks',
      '--input-type=module',
      '--eval',
      probe,
      JSON.stringify({ runnerPath, runnerUrl: runnerUrl.href, code, signal }),
    ]);
    assert.equal(result.status, expectedStatus, result.stderr);
    // The run ends with the failure summary block, so the probe line is first.
    const invocation = JSON.parse(result.stdout.split('\n')[0]);
    assert.equal(
      result.stdout.trimEnd().split('\n').at(-1),
      `${SUMMARY_TAG} 0 failed, 0 flaky (every failed test is named below)`
    );
    const logPath = /^Full test log: (.+)$/m.exec(result.stderr)?.[1];
    assert.ok(logPath?.startsWith(join(tmpdir(), 'mixdog-test-output-')));
    assert.ok(logPath.endsWith('full.log'));
    t.after(() => rm(dirname(logPath), { recursive: true, force: true }));
    const { failureRecords, ...invariant } = invocation;
    assert.deepEqual(invariant, {
      executable: process.execPath,
      args: [
        '--import',
        'setup.mjs',
        '--test-only',
        '--experimental-test-module-mocks',
        '--test',
        '--test-force-exit',
        `--test-reporter=${summaryReporterUrl}`,
        '--test-reporter-destination=stdout',
        '--test-reporter=spec',
        `--test-reporter-destination=${logPath}`,
        'src/omega.slow.test.mjs',
      ],
      stdio: 'inherit',
      inheritsEnvironment: true,
      event: 'exit',
    });
    // Failure records stay off the command line, which is already budgeted.
    assert.ok(failureRecords.startsWith(join(tmpdir(), 'mixdog-test-failures-')), failureRecords);
    assert.ok(failureRecords.endsWith('batch-1.jsonl'), failureRecords);
    assert.ok(!invocation.args.some((arg) => arg.includes('mixdog-test-failures-')));
  }
});

test('CLI executes selected tests with forwarded imports and name filters, reporting success and failure', async (t) => {
  const cwd = await fixture(t, {
    'setup.mjs': 'globalThis.fromRunnerImport = true;',
    'src/pass.test.mjs': `
      import assert from 'node:assert/strict';
      import test from 'node:test';
      test('chosen', () => {
        console.error('fixture warning is preserved');
        assert.equal(globalThis.fromRunnerImport, true);
      });
      test('chosen skipped', { skip: 'fixture skip' }, () => {});
      test('ignored', () => assert.fail('name filter was not forwarded'));
    `,
    'src/fail.test.mjs': `
      import test from 'node:test';
      test('fails', () => { throw new Error('fixture assertion failure'); });
    `,
  });
  const pass = runNode(cwd, [
    runnerPath,
    '--import',
    pathToFileURL(join(cwd, 'setup.mjs')).href,
    '--test-name-pattern=chosen',
    'src/pass.test.mjs',
  ]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.doesNotMatch(pass.stdout, /✔ chosen \(/);
  assert.match(pass.stdout, /chosen skipped.*fixture skip/);
  assert.match(pass.stdout, /fixture warning is preserved/);
  assert.match(pass.stdout, /fail 0/);
  assert.match(pass.stdout, /skipped 1/);
  assert.match(pass.stdout, /slowest files \(1 files,/);
  assert.match(pass.stdout, /src\/pass\.test\.mjs/);
  const fullLogPath = /^Full test log: (.+)$/m.exec(pass.stderr)?.[1];
  assert.ok(fullLogPath?.startsWith(join(tmpdir(), 'mixdog-test-output-')));
  t.after(() => rm(dirname(fullLogPath), { recursive: true, force: true }));
  const fullLog = await readFile(fullLogPath, 'utf8');
  assert.match(fullLog, /chosen/);
  assert.match(fullLog, /fixture warning is preserved/);
  assert.doesNotMatch(pass.stderr, /MaxListenersExceededWarning/);
  // A clean run still ends with the summary block, so its absence is a signal.
  assert.equal(
    pass.stdout.trimEnd().split('\n').at(-1),
    `${SUMMARY_TAG} 0 failed, 0 flaky (every failed test is named below)`
  );
  const fail = runNode(cwd, [runnerPath, 'src/fail.test.mjs']);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /fixture assertion failure/);
  assert.match(fail.stdout, /fail 1/);
  assert.match(fail.stdout, /src\/fail\.test\.mjs\s+\(failed\)/);
  // The block is last and every line names itself, so a filtered log — the
  // way `ℹ fail 1` was once read without a name — still identifies the test.
  const failSummary = fail.stdout.trimEnd().split('\n').slice(-3);
  assert.deepEqual(failSummary, [
    `${SUMMARY_TAG} 1 failed, 0 flaky (every failed test is named below)`,
    `${SUMMARY_TAG} FAILED src/fail.test.mjs > fails`,
    `${SUMMARY_TAG} ${policyLine(0)}`,
  ]);
});

test('--rerun-failed reports a flaky test in its own category and states its exit policy', async (t) => {
  const cwd = await fixture(t, {
    // Fails on its first attempt only, like the load-sensitive suites that
    // three re-runs once hid.
    'src/flaky.test.mjs': `
      import assert from 'node:assert/strict';
      import { existsSync, writeFileSync } from 'node:fs';
      import test from 'node:test';
      const marker = new URL('./attempt.marker', import.meta.url);
      test('load sensitive', () => {
        const firstAttempt = !existsSync(marker);
        writeFileSync(marker, 'seen');
        assert.equal(firstAttempt, false, 'first attempt fails, later attempts pass');
      });
    `,
    'src/broken.test.mjs': `
      import test from 'node:test';
      test('always fails', () => { throw new Error('deterministic failure'); });
    `,
  });
  const logDirectories = [];
  const run = (args) => {
    const result = runNode(cwd, [runnerPath, ...args]);
    logDirectories.push(dirname(/^Full test log: (.+)$/m.exec(result.stderr)[1]));
    return result;
  };
  t.after(() => Promise.all(logDirectories.map((directory) => rm(directory, { recursive: true, force: true }))));

  // Without the flag the flaky test is an ordinary failure: nothing is folded
  // into the pass count and the run still fails.
  const strict = run(['src/flaky.test.mjs']);
  assert.equal(strict.status, 1);
  assert.ok(strict.stdout.includes(`${SUMMARY_TAG} FAILED src/flaky.test.mjs > load sensitive`), strict.stdout);
  await rm(join(cwd, 'src', 'attempt.marker'), { force: true });

  const tolerated = run(['--rerun-failed', '2', 'src/flaky.test.mjs']);
  assert.equal(tolerated.status, 0, 'a flaky test does not fail a run that asked for re-runs');
  assert.match(tolerated.stdout, /0 failed, 1 flaky/);
  assert.match(tolerated.stdout, /FLAKY src\/flaky\.test\.mjs > load sensitive \(failed, then passed on re-run 1\/2\)/);
  assert.match(tolerated.stdout, /flaky test does not fail the run/);
  assert.doesNotMatch(tolerated.stdout, /FAILED src\/flaky/);
  assert.match(tolerated.stderr, /Re-running 1 failed file\(s\): attempt 1\/2/);
  await rm(join(cwd, 'src', 'attempt.marker'), { force: true });

  // A test that fails every re-run keeps failing the run, and the flaky one
  // beside it is still named separately.
  const mixed = run(['--rerun-failed', '2']);
  assert.equal(mixed.status, 1);
  const summary = mixed.stdout.trimEnd().split('\n').slice(-4);
  assert.deepEqual(summary, [
    `${SUMMARY_TAG} 1 failed, 1 flaky (every failed test is named below)`,
    `${SUMMARY_TAG} FAILED src/broken.test.mjs > always fails`,
    `${SUMMARY_TAG} FLAKY src/flaky.test.mjs > load sensitive (failed, then passed on re-run 1/2)`,
    `${SUMMARY_TAG} ${policyLine(2)}`,
  ]);
  assert.match(mixed.stderr, /Re-running 2 failed file\(s\): attempt 1\/2/);
  assert.match(mixed.stderr, /Re-running 1 failed file\(s\): attempt 2\/2/);
});

test('explicit Node runs preserve imports, nested failures, skip/todo reasons and the full log', async (t) => {
  const cwd = await fixture(t, {
    'setup.mjs': 'globalThis.directImport = true;',
    'isolated.mjs': `
      import assert from 'node:assert/strict';
      import test from 'node:test';
      test('ordinary success', () => assert.equal(globalThis.directImport, true));
      test('not installed', { skip: 'missing dependency' }, () => {});
      test('future work', { todo: 'pending support' }, () => {});
      test('parent', async (t) => {
        await t.test('nested failure', () => {
          console.warn('warning stays visible');
          assert.equal(1, 2, 'independent failure detail');
        });
      });
    `,
  });
  const directPath = fileURLToPath(new URL('./test-direct.mjs', import.meta.url));
  const result = runNode(cwd, [directPath, '--import', pathToFileURL(join(cwd, 'setup.mjs')).href, 'isolated.mjs']);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /ordinary success/);
  assert.match(result.stdout, /missing dependency/);
  assert.match(result.stdout, /pending support/);
  assert.match(result.stdout, /nested failure/);
  assert.match(result.stdout, /independent failure detail/);
  assert.match(result.stdout, /warning stays visible/);
  assert.match(result.stdout, /skipped 1/);
  assert.match(result.stdout, /todo 1/);
  const logPath = /^Full test log: (.+)$/m.exec(result.stderr)?.[1];
  assert.ok(logPath?.startsWith(join(tmpdir(), 'mixdog-test-output-')));
  t.after(() => rm(dirname(logPath), { recursive: true, force: true }));
  const log = await readFile(logPath, 'utf8');
  assert.match(log, /ordinary success/);
  assert.match(log, /independent failure detail/);
});
