import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverTestFiles, laneOf, parseArgs, selectTestFiles } from './test.mjs';

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
  assert.equal(laneOf('src/a.LIVE.test.mjs'), 'fast');
  assert.equal(laneOf('src/slow/a.test.mjs'), 'fast');
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
    message: 'unknown lane "nightly" (fast|slow|live|all)',
  });
  assert.throws(() => parseArgs(['--lane']), {
    message: 'unknown lane "undefined" (fast|slow|live|all)',
  });
});

test('discovery limits roots and suffixes, excludes whole directory segments, and sorts paths', async (t) => {
  const cwd = await fixture(t, {
    'src/a.test.mjs': '',
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
    'scripts/zeta-test.mjs': '',
  });
  const fast = runNode(cwd, [runnerPath, '--list']);
  assert.equal(fast.status, 0);
  assert.equal(fast.stdout, 'fast  scripts/zeta-test.mjs\nfast  src/alpha.test.mjs\n');
  assert.equal(fast.stderr, '');
  const all = runNode(cwd, [runnerPath, '--lane=all', '--list']);
  assert.equal(all.status, 0);
  assert.equal(
    all.stdout,
    'fast  scripts/zeta-test.mjs\nfast  src/alpha.test.mjs\nlive  src/beta.live.test.mjs\nslow  src/omega.slow.test.mjs\n'
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
  assert.match(invalid.stderr, /unknown lane "nightly" \(fast\|slow\|live\|all\)/);
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
              process.stdout.write(JSON.stringify({ executable, args, options, event }) + '\\n');
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
    const invocation = JSON.parse(result.stdout);
    const logPath = /^Full test log: (.+)$/m.exec(result.stderr)?.[1];
    assert.ok(logPath?.startsWith(join(tmpdir(), 'mixdog-test-output-')));
    assert.ok(logPath.endsWith('full.log'));
    t.after(() => rm(dirname(logPath), { recursive: true, force: true }));
    assert.deepEqual(invocation, {
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
      options: { stdio: 'inherit' },
      event: 'exit',
    });
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
  const fail = runNode(cwd, [runnerPath, 'src/fail.test.mjs']);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /fixture assertion failure/);
  assert.match(fail.stdout, /fail 1/);
  assert.match(fail.stdout, /src\/fail\.test\.mjs\s+\(failed\)/);
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
