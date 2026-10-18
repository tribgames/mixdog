// The suite is discovered, not listed: a full run hands Node ~700 paths, which
// overflows the OS command line. These cases pin the batching that keeps a
// full run alive and the flag errors that must stay flag errors.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  ARG_BUDGET,
  chunkFileArgs,
  explicitFilesTimeoutMs,
  ownedProcesses,
  testConcurrencyArg,
  testTimeoutArg,
} from './lib/run-node-tests.mjs';
import { defaultRerunFailed } from './test.mjs';
import { parseArgs } from './test.mjs';

const runnerPath = fileURLToPath(new URL('./test.mjs', import.meta.url));
const runNodeTestsUrl = new URL('./lib/run-node-tests.mjs', import.meta.url).href;
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
const cost = (files) => files.reduce((total, file) => total + file.length + 3, 0);

async function fixture(t, entries) {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-test-runner-argv-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(entries)) {
    const path = join(cwd, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return cwd;
}

function runNode(cwd, args, timeout = 60_000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('test concurrency: explicit choices win, otherwise Node default', () => {
  assert.equal(testConcurrencyArg([], {}), null, 'Node default');
  assert.equal(testConcurrencyArg([], { MIXDOG_TEST_CONCURRENCY: 'x' }), null);
  assert.equal(testConcurrencyArg([], { MIXDOG_TEST_CONCURRENCY: '3' }), '--test-concurrency=3');
  assert.equal(testConcurrencyArg(['--test-concurrency=9'], { MIXDOG_TEST_CONCURRENCY: '6' }), null);
  assert.equal(testConcurrencyArg(['--test-concurrency', '9'], {}), null);
});

test('explicitly named slow-lane files keep the long per-file bound under test-direct', () => {
  assert.equal(explicitFilesTimeoutMs(['src/a.test.mjs', 'scripts/b-test.mjs']), 120_000);
  assert.equal(explicitFilesTimeoutMs(['src/a.test.mjs', 'src/x/manager.slow.test.mjs']), 600_000);
  assert.equal(explicitFilesTimeoutMs(['src/y.live.test.mjs']), 600_000);
});

test('per-file timeout: flag wins, env overrides the lane default, 0 disables', () => {
  assert.equal(testTimeoutArg([], {}, 120_000), '--test-timeout=120000');
  assert.equal(testTimeoutArg([], { MIXDOG_TEST_TIMEOUT_MS: '5000' }, 120_000), '--test-timeout=5000');
  assert.equal(testTimeoutArg([], { MIXDOG_TEST_TIMEOUT_MS: '0' }, 120_000), null);
  assert.equal(testTimeoutArg(['--test-timeout=9'], { MIXDOG_TEST_TIMEOUT_MS: '5000' }, 120_000), null);
});

test('local runs re-run failures once; CI stays strict unless it opts in', () => {
  assert.equal(defaultRerunFailed({}), 1);
  assert.equal(defaultRerunFailed({ CI: 'true' }), 0);
  assert.equal(defaultRerunFailed({ CI: 'true', MIXDOG_TEST_RERUN_FAILED: '2' }), 2);
  assert.equal(defaultRerunFailed({ MIXDOG_TEST_RERUN_FAILED: '0' }), 0);
});

test('a full-suite file list is batched under the command-line cap, in order', () => {
  const files = Array.from(
    { length: 716 },
    (_, index) => `src/runtime/agent/orchestrator/session/suite-${String(index).padStart(3, '0')}.test.mjs`
  );
  const budget = 30_000;
  assert.ok(cost(files) > budget, 'a full suite must not fit in one spawn');
  const batches = chunkFileArgs(files, budget);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), files);
  for (const batch of batches) {
    assert.ok(batch.length > 0);
    assert.ok(cost(batch) <= budget);
  }
  if (process.platform === 'win32') assert.ok(ARG_BUDGET < WINDOWS_COMMAND_LINE_LIMIT);
});

test('batching keeps an empty list and an oversized single path runnable', () => {
  assert.deepEqual(chunkFileArgs([], 100), [[]]);
  assert.deepEqual(chunkFileArgs(['src/a.test.mjs'], 100), [['src/a.test.mjs']]);
  const huge = `src/${'long-'.repeat(20)}.test.mjs`;
  assert.deepEqual(chunkFileArgs([huge, 'src/b.test.mjs'], 10), [[huge], ['src/b.test.mjs']]);
});

test('a batched run executes every file, keeps one full log, and fails on any failing batch', async (t) => {
  const cwd = await fixture(t, {
    'first.test.mjs': "import test from 'node:test';\ntest('first batch case', () => {});\n",
    'second.test.mjs':
      "import test from 'node:test';\ntest('second batch case', () => { throw new Error('second batch failure'); });\n",
    'third.test.mjs': "import test from 'node:test';\ntest('third batch case', () => {});\n",
  });
  const probe = `
    const { runNodeTests } = await import(${JSON.stringify(runNodeTestsUrl)});
    await runNodeTests(['--test'], JSON.parse(process.argv[1]), { argBudget: 1 });
  `;
  const files = ['first.test.mjs', 'second.test.mjs', 'third.test.mjs'];
  const result = runNode(cwd, ['--input-type=module', '--eval', probe, JSON.stringify(files)]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.match(/^Full test log: /gm).length, 1);
  assert.equal(result.stdout.match(/^. duration_ms /gm).length, files.length, 'one batch per file');
  assert.match(result.stdout, /second batch failure/);
  const logPath = /^Full test log: (.+)$/m.exec(result.stderr)[1];
  t.after(() => rm(dirname(logPath), { recursive: true, force: true }));
  assert.deepEqual(await readdir(dirname(logPath)), ['full.log'], 'per-batch logs are merged away');
  const log = await readFile(logPath, 'utf8');
  for (const name of ['first batch case', 'second batch case', 'third batch case']) assert.match(log, new RegExp(name));
});

test('a valueless --import is a flag error, never an undefined spawn argument', () => {
  assert.throws(() => parseArgs(['--import']), { message: '--import requires a value' });
  assert.throws(() => parseArgs(['src/lib', '--import']), { message: '--import requires a value' });
  assert.deepEqual(parseArgs(['--import', 'setup.mjs']).nodeArgs, ['--import', 'setup.mjs']);
  const result = runNode(process.cwd(), [runnerPath, '--import'], 10_000);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--import requires a value/);
  assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE/);
});

test('separate test batches share tools but retain their own session data', async (t) => {
  const child = `
    import assert from 'node:assert/strict';
    import { appendFileSync, mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import test from 'node:test';
    test('private fixture', () => {
      const data = mkdtempSync(join(tmpdir(), 'session-'));
      const cache = process.env.MIXDOG_TEST_OOXML_CACHE_DIR;
      assert.ok(cache);
      appendFileSync('paths.jsonl', JSON.stringify({ data, cache }) + '\\n');
    });
  `;
  const cwd = await fixture(t, { 'a.test.mjs': child, 'b.test.mjs': child });
  const probe = `
    const { runNodeTests } = await import(${JSON.stringify(runNodeTestsUrl)});
    await runNodeTests(['--test'], ['a.test.mjs', 'b.test.mjs'], { argBudget: 1 });
  `;
  const result = runNode(cwd, ['--input-type=module', '--eval', probe]);
  assert.equal(result.status, 0, result.stderr);
  const rows = (await readFile(join(cwd, 'paths.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cache, rows[1].cache);
  assert.notEqual(rows[0].data, rows[1].data);
  assert.notEqual(rows[0].cache, rows[0].data);
});

test('explicit runs keep exact paths/globs, slow/live files, heap flags and preloads', async (t) => {
  const source = `
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    import test from 'node:test';
    import v8 from 'node:v8';
    test('selected case', () => {
      assert.equal(globalThis.directPreload, true);
      // The cap that applies, not the flag text: Node 24 rebuilds a test
      // process's execArgv and drops V8 flags, and the runner forwards them.
      assert.ok(v8.getHeapStatistics().heap_size_limit < 512 * 1024 * 1024);
      assert.ok(process.env.MIXDOG_TEST_OOXML_CACHE_DIR);
      appendFileSync('selected.jsonl', JSON.stringify(import.meta.url) + '\\n');
    });
    test('filtered case', () => assert.fail('name filter must be preserved'));
  `;
  const cwd = await fixture(t, {
    'setup.mjs': 'globalThis.directPreload = true;',
    'chosen/a.slow.test.mjs': source,
    'chosen/b.live.test.mjs': source,
    'exact.test.mjs': source,
    'exact.test.mjs.extra.test.mjs': "throw new Error('not an exact path');",
    'unselected.test.mjs': "throw new Error('must not discover other tests');",
  });
  const directPath = fileURLToPath(new URL('./test-direct.mjs', import.meta.url));
  const result = runNode(cwd, [
    '--max-old-space-size=128',
    '--import',
    './setup.mjs',
    directPath,
    '--test-name-pattern',
    'selected case',
    'chosen/*.test.mjs',
    'exact.test.mjs',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const selected = (await readFile(join(cwd, 'selected.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  // Module URLs carry the resolved path (macOS tmpdir /var is /private/var).
  const root = await realpath(cwd);
  assert.deepEqual(
    selected.map((url) => fileURLToPath(url)).sort(),
    [join(root, 'chosen/a.slow.test.mjs'), join(root, 'chosen/b.live.test.mjs'), join(root, 'exact.test.mjs')].sort()
  );
});

test('explicit runs get module mocks and force-exit, also when the caller already passed them', async (t) => {
  const cwd = await fixture(t, {
    'dep.mjs': 'export const value = () => "real";\n',
    'mocked.test.mjs': `
      import assert from 'node:assert/strict';
      import test, { mock } from 'node:test';
      mock.module('./dep.mjs', { namedExports: { value: () => 'mocked' } });
      const { value } = await import('./dep.mjs');
      // A handle the suite never closes: force-exit ends the file anyway.
      setInterval(() => {}, 1000);
      test('module mock applies', () => assert.equal(value(), 'mocked'));
    `,
  });
  const directPath = fileURLToPath(new URL('./test-direct.mjs', import.meta.url));
  for (const flags of [[], ['--test-force-exit', '--experimental-test-module-mocks']]) {
    const result = runNode(cwd, [directPath, ...flags, 'mocked.test.mjs']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    t.after(() => rm(dirname(/^Full test log: (.+)$/m.exec(result.stderr)[1]), { recursive: true, force: true }));
  }
});

test('a process a test leaves running is killed, while one that only names the scratch root survives', async (t) => {
  const cwd = await fixture(t, {
    // Like the memory runtime's postgres: a detached, long-lived process that
    // sits several directories deep in the data dir, so it outlives its test
    // and holds the scratch root the runner removes. The test then waits for
    // a bystander outside the run that names the same root on its command line.
    'leak.test.mjs': `
      import { spawn } from 'node:child_process';
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import test from 'node:test';
      import { setTimeout as delay } from 'node:timers/promises';
      test('starts a server and forgets it', async () => {
        const data = process.env.MIXDOG_DATA_DIR;
        const nested = join(data, 'a', 'b', 'c');
        mkdirSync(nested, { recursive: true });
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', data], {
          cwd: nested,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        writeFileSync('leak.json', JSON.stringify({ pid: child.pid, scratch: process.env.TEMP }));
        for (let waited = 0; !existsSync('bystander.ready') && waited < 30_000; waited += 100) await delay(100);
      });
    `,
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const probe = `
    const { runNodeTests } = await import(${JSON.stringify(runNodeTestsUrl)});
    await runNodeTests(['--test'], ['leak.test.mjs']);
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawn(process.execPath, ['--input-type=module', '--eval', probe], { cwd, env });
  const output = { stdout: '', stderr: '' };
  run.stdout.on('data', (chunk) => (output.stdout += chunk));
  run.stderr.on('data', (chunk) => (output.stderr += chunk));
  const status = new Promise((resolve) => run.on('close', resolve));
  const leakPath = join(cwd, 'leak.json');
  for (let waited = 0; !existsSync(leakPath) && waited < 30_000; waited += 100) await delay(100);
  const { pid, scratch } = JSON.parse(await readFile(leakPath, 'utf8'));
  t.after(() => alive(pid) && process.kill(pid));
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', scratch], { stdio: 'ignore' });
  t.after(() => bystander.kill());
  await new Promise((resolve) => bystander.on('spawn', resolve));
  await writeFile(join(cwd, 'bystander.ready'), '');
  const code = await status;
  t.after(() => rm(dirname(/^Full test log: (.+)$/m.exec(output.stderr)[1]), { recursive: true, force: true }));
  assert.equal(code, 0, output.stdout + output.stderr);
  assert.match(output.stderr, new RegExp(`Killing \\d+ process\\(es\\) a test left running: (?:\\d+ )*${pid}\\b`));
  assert.doesNotMatch(output.stderr, new RegExp(`left running:.*\\b${bystander.pid}\\b`));
  assert.equal(alive(pid), false, 'the leaked process was killed');
  assert.equal(alive(bystander.pid), true, 'the process outside the run survived');
  assert.match(output.stdout.trimEnd().split('\n').at(-1), /^\[failure-summary\] 0 failed, 0 flaky/);
});

test('ownership follows recorded spawns and their descendants, never a reused pid', () => {
  const scratchDir = join(tmpdir(), 'mixdog-test-scratch-x');
  const batchStart = 1_000_000;
  const at = (offset) => batchStart + offset;
  const snapshot = [
    // Orphan of recorded spawn 10 (exited), and its child.
    { pid: 11, ppid: 10, created: at(5_000), exe: 'C:\\Windows\\System32\\cmd.exe' },
    { pid: 12, ppid: 11, created: at(5_100), exe: 'C:\\pg\\postgres.exe' },
    // Recorded spawn 20 is alive under its own identity.
    { pid: 20, ppid: 1, created: at(6_000), exe: 'node.exe' },
    // Pid 30 was recorded, exited and was reused by a later, unrelated process:
    // its younger child is not the run's, an older orphan of the recorded one is.
    { pid: 30, ppid: 1, created: at(60_000), exe: 'editor.exe' },
    { pid: 31, ppid: 30, created: at(61_000), exe: 'editor-helper.exe' },
    { pid: 32, ppid: 30, created: at(8_000), exe: 'node.exe' },
    // Executes from the scratch root, parent unknown.
    { pid: 40, ppid: 2, created: at(9_000), exe: join(scratchDir, 'data', 'pg', 'bin', 'postgres.exe') },
    // Only names the scratch root; not started by the run.
    { pid: 50, ppid: 3, created: at(9_500), exe: 'code.exe' },
  ];
  const anchors = [
    { pid: 10, since: at(4_900) },
    { pid: 20, since: at(6_000) },
    { pid: 30, since: at(7_000) },
  ];
  const owned = ownedProcesses(snapshot, anchors, { batchStart, scratchDir, platform: 'win32' });
  assert.deepEqual(
    owned.map((entry) => entry.pid).sort((a, b) => a - b),
    [11, 12, 20, 32, 40]
  );
});

test('a batch that never finishes is killed by the watchdog and named, and later batches still run', async (t) => {
  const cwd = await fixture(t, {
    'hang.test.mjs':
      "import test from 'node:test';\ntest('never settles', () => new Promise(() => setInterval(() => {}, 1000)));\n",
    'after.test.mjs': "import test from 'node:test';\ntest('later batch case', () => {});\n",
  });
  const probe = `
    process.env.MIXDOG_TEST_BATCH_TIMEOUT_MS = '2000';
    const { runNodeTests } = await import(${JSON.stringify(runNodeTestsUrl)});
    await runNodeTests(['--test'], ['hang.test.mjs', 'after.test.mjs'], { argBudget: 1 });
  `;
  const result = runNode(cwd, ['--input-type=module', '--eval', probe], 60_000);
  t.after(() => rm(dirname(/^Full test log: (.+)$/m.exec(result.stderr)[1]), { recursive: true, force: true }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Test batch hung after 0\.03 min: hang\.test\.mjs; killing its process tree/);
  assert.match(result.stdout, /^\s+\d+ms {2}after\.test\.mjs$/m, 'the next batch ran');
  assert.deepEqual(result.stdout.trimEnd().split('\n').slice(-3), [
    '[failure-summary] 0 failed, 0 flaky, 1 hung batch(es) (every failed test is named below)',
    '[failure-summary] HUNG hung after 0.03 min: hang.test.mjs',
    '[failure-summary] policy: --rerun-failed is off, so every failure fails the run (pass --rerun-failed <n> to classify flaky)',
  ]);
});

for (const explicit of [false, true]) {
  test(`explicit runs honor ${explicit ? 'a CLI override' : 'the shared concurrency budget'}`, async (t) => {
    const source = `
      import assert from 'node:assert/strict';
      import { closeSync, openSync, unlinkSync } from 'node:fs';
      import test from 'node:test';
      import { setTimeout } from 'node:timers/promises';
      test('exclusive fixture', async () => {
        const fd = openSync('active.lock', 'wx');
        try {
          assert.ok(process.env.MIXDOG_TEST_OOXML_CACHE_DIR);
          await setTimeout(100);
        } finally { closeSync(fd); unlinkSync('active.lock'); }
      });
    `;
    const cwd = await fixture(t, {
      'a.test.mjs': source,
      'b.test.mjs': source,
      'budget.mjs': `process.env.MIXDOG_TEST_CONCURRENCY = '${explicit ? 4 : 1}';`,
    });
    const directPath = fileURLToPath(new URL('./test-direct.mjs', import.meta.url));
    const result = runNode(cwd, [
      '--import',
      './budget.mjs',
      directPath,
      ...(explicit ? ['--test-concurrency', '1'] : []),
      'a.test.mjs',
      'b.test.mjs',
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('--test-timeout consumes its value in both forms and a valueless one is a flag error', () => {
  assert.deepEqual(parseArgs(['--test-timeout', '120000']).nodeArgs, ['--test-timeout=120000']);
  assert.deepEqual(parseArgs(['--test-timeout=120000']).nodeArgs, ['--test-timeout=120000']);
  assert.deepEqual(parseArgs(['--test-timeout', '120000', 'src/lib']).filters, ['src/lib']);
  assert.throws(() => parseArgs(['--test-timeout']), { message: '--test-timeout requires a value' });
});

test('--test-concurrency consumes its value in both forms and still beats the env setting', () => {
  assert.deepEqual(parseArgs(['--test-concurrency', '3']).nodeArgs, ['--test-concurrency=3']);
  assert.deepEqual(parseArgs(['--test-concurrency=3']).nodeArgs, ['--test-concurrency=3']);
  assert.deepEqual(parseArgs(['--test-concurrency', '3', 'src/lib']).filters, ['src/lib']);
  assert.throws(() => parseArgs(['--test-concurrency']), { message: '--test-concurrency requires a value' });
  const { nodeArgs } = parseArgs(['--test-concurrency', '3']);
  assert.equal(testConcurrencyArg(nodeArgs, { MIXDOG_TEST_CONCURRENCY: '8' }), null);
});

test('a non-zero exit with no failed test is reported as a failed run, not "0 failed"', async () => {
  const { formatFailureSummary } = await import('./lib/test-failure-summary.mjs');
  assert.match(formatFailureSummary({ exitCode: 9 }), /^\[failure-summary\] RUN FAILED: exit code 9/);
  assert.match(formatFailureSummary({ exitCode: 0 }), /^\[failure-summary\] 0 failed, 0 flaky/);
});
